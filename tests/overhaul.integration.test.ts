import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { registerUser } from '../server/services/userAccountService'
import { minesField, minesTerms } from '../server/utils/minesMath'
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:3106'
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname))
assert.match(process.env.DATABASE_URL || '', /(:55439\/|_test)/)
const db=new PrismaClient()
const users:string[]=[], rooms:string[]=[]
async function req(path:string,body?:unknown,token?:string,status=200):Promise<any>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)})
  const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data
}
async function account(role='USER',balance=5000){
  const user=await registerUser({username:'new_'+randomUUID().slice(0,12),password:'Test-only-strong-password'})
  users.push(user.user.id)
  await db.$transaction([db.user.update({where:{id:user.user.id},data:{role,balance,...(role === 'SUPERADMIN' && process.env.TEST_BANK_PHONE ? {phone:process.env.TEST_BANK_PHONE} : {})}}),db.userWallet.update({where:{userId:user.user.id},data:{balance:BigInt(balance)}})])
  return {id:user.user.id,token:user.token}
}
async function total(){
  const wallets=await db.userWallet.aggregate({_sum:{balance:true}})
  const active=await db.miniGameSession.findMany({where:{status:'ACTIVE'}})
  return (wallets._sum.balance || 0n)+active.reduce((sum,s)=>sum+s.stake+s.bankReserve,0n)
}
async function start(user:{token:string},extra:Record<string,unknown>={}){
  const commit=await req('/api/mines/prepare',{},user.token)
  assert.ok(commit.serverSeedHash && !commit.serverSeed)
  const input={stake:100,mines:5,clientSeed:'test-client',commitmentId:commit.commitmentId,idempotencyKey:randomUUID(),...extra}
  const result=await req('/api/mines/start',input,user.token)
  assert.equal(result.session.serverSeedHash,commit.serverSeedHash)
  return {input,session:result.session}
}
async function cells(id:string){
  const s=await db.miniGameSession.findUniqueOrThrow({where:{id}})
  const mines=minesField(s.serverSeed!,s.clientSeed!,s.nonce,s.mines!)
  return {mine:mines.find(i=>Math.floor(i/5)===0)!,safe:Array.from({length:25},(_,i)=>i).filter(i=>!mines.includes(i) && Math.floor(i/5)===0)}
}
let house:{id:string;token:string}
test('Mines start reserve, restore, concurrent safe open and double cashout conserve chips',async()=>{
  house=await account('SUPERADMIN',5_000_000)
  const user=await account()
  const before=await total()
  const {input,session}=await start(user)
  assert.equal(await total(),before)
  assert.ok(!('serverSeed' in session) && !('mineCells' in session))
  assert.equal((await req('/api/mines/state',undefined,user.token)).active.id,session.id)
  await req('/api/mines/cashout',{sessionId:session.id},user.token,409)
  assert.equal((await req('/api/mines/start',input,user.token)).session.id,session.id)
  await req('/api/mines/start',{...input,stake:101},user.token,409)
  await req('/api/mines/verify?sessionId='+session.id,undefined,user.token,404)
  const {safe}=await cells(session.id)
  const opened=await Promise.all(Array.from({length:3},()=>req('/api/mines/open',{sessionId:session.id,cell:safe[0]},user.token)))
  for(const response of opened) assert.equal(response.session.safeOpened,1)
  const payouts=await Promise.all(Array.from({length:4},()=>req('/api/mines/cashout',{sessionId:session.id},user.token)))
  for(const p of payouts) assert.equal(p.session.payout,117)
  assert.equal(await db.walletLedgerEntry.count({where:{idempotencyKey:'mines:payout:'+session.id}}),1)
  assert.equal(await total(),before)
  assert.equal((await req('/api/mines/verify?sessionId='+session.id,undefined,user.token)).verified,true)
})
test('Mines loss and duplicate mine open settle once; foreign users and fractional cells rejected',async()=>{
  const user=await account(),other=await account()
  const before=await total(),{session}=await start(user),{mine}=await cells(session.id)
  await req('/api/mines/open',{sessionId:session.id,cell:mine},other.token,404)
  await req('/api/mines/open',{sessionId:session.id,cell:.5},user.token,400)
  const results=await Promise.all([req('/api/mines/open',{sessionId:session.id,cell:mine},user.token),req('/api/mines/open',{sessionId:session.id,cell:mine},user.token)])
  for(const r of results){assert.equal(r.session.status,'LOST');assert.equal(r.session.payout,0);assert.equal(r.session.mineCells.length,5)}
  await req('/api/mines/cashout',{sessionId:session.id},user.token,409)
  assert.equal(await total(),before)
  assert.equal((await db.walletLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:'mines:stake:'+session.id}})).metadata && ((await db.walletLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:'mines:stake:'+session.id}})).metadata as any).outcome,'LOST')
  assert.equal((await req('/api/mines/verify?sessionId='+session.id,undefined,user.token)).verified,true)
})
test('concurrent distinct starts allow one active session; cashout racing mine is financially atomic',async()=>{
  const user=await account(),commit=await req('/api/mines/prepare',{},user.token)
  const input={stake:100,mines:5,clientSeed:'race',commitmentId:commit.commitmentId}
  const before=await total()
  const responses=await Promise.all([1,2].map(async()=>fetch(base+'/api/mines/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify({...input,idempotencyKey:randomUUID()})})))
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409])
  const {session}=await responses.find(r=>r.status===200)!.json()
  const {safe,mine}=await cells(session.id)
  await req('/api/mines/open',{sessionId:session.id,cell:safe[0]},user.token)
  const raced=await Promise.all(['open','cashout'].map(path=>fetch(base+'/api/mines/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify({sessionId:session.id,...(path==='open'?{cell:mine}:{})})})))
  assert.equal(raced.filter(r=>r.status===200).length,1)
  assert.equal(await total(),before)
})
test('bank cannot promise uncovered payout and max payout automatically cashes out',async()=>{
  const user=await account()
  const original=await db.userWallet.findUniqueOrThrow({where:{userId:house.id}})
  await db.userWallet.update({where:{userId:house.id},data:{balance:1n}})
  const commit=await req('/api/mines/prepare',{},user.token),input={stake:100,mines:10,clientSeed:'cap',commitmentId:commit.commitmentId,idempotencyKey:randomUUID()}
  const before=await total()
  await req('/api/mines/start',input,user.token,409);assert.equal(await total(),before)
  await db.userWallet.update({where:{userId:house.id},data:{balance:original.balance}})
  const baseline=await total(),{session}=await req('/api/mines/start',input,user.token),{safe}=await cells(session.id)
  let current=session
  for(let column=0;column<5;column++){const cell=minesField(session.serverSeed!,session.clientSeed!,session.nonce,session.mines!).find(i=>Math.floor(i/5)===column)!; const safeCell=Array.from({length:5},(_,i)=>column*5+i).find(i=>i!==cell)!; current=(await req('/api/mines/open',{sessionId:session.id,cell:safeCell},user.token)).session;if(current.status!=='ACTIVE')break}
  assert.equal(current.status,'CASHED_OUT');assert.equal(current.payout,1200)
  assert.equal(await total(),baseline)
})
async function room(){
  const r=await req('/api/rooms/create',{name:'Overhaul test',startingStack:1000,smallBlind:5,bigBlind:10,maxPlayers:8,allowLateJoin:true,requireDealerActionApproval:false,allowSpectators:true,buyIn:{enabled:true,minBuyIn:100,maxBuyIn:2000,allowTopUp:true},predictions:{enabled:true}})
  rooms.push(r.roomCode);return r
}
async function join(r:any,u:any,role='player'){return req('/api/rooms/'+r.roomCode+'/join',{name:'ignored',role,authToken:u.token,buyInAmount:1000,clientRequestId:randomUUID()})}
async function state(r:any){return req('/api/rooms/'+r.roomCode+'/state',undefined,r.dealerSecret)}
async function command(r:any,path:string,extra:Record<string,unknown>={},status=200){return req('/api/rooms/'+r.roomCode+'/'+path,{dealerSecret:r.dealerSecret,...extra},undefined,status)}
async function act(r:any,p:any,type:string,status=200){const s=await state(r);return req('/api/rooms/'+r.roomCode+'/action',{playerId:p.playerId,token:p.playerSessionToken,type,amount:0,clientRequestId:randomUUID(),handId:s.currentHand.id,expectedRevision:s.room.revision},undefined,status)}
test('stack return exact mirror, concurrent retries, invalid amount, ownership and live commitments',async()=>{
  const a=await account(),b=await account(),r=await room(),p=await join(r,a);await join(r,b)
  const s=await state(r),memberId=s.players.find((x:any)=>x.id===p.playerId).memberId
  const body={accountToken:a.token,memberId,amount:250,clientRequestId:randomUUID()},before=await db.userWallet.findUniqueOrThrow({where:{userId:a.id}})
  await req('/api/rooms/'+r.roomCode+'/return-stack',{...body,amount:1.5},undefined,400)
  await req('/api/rooms/'+r.roomCode+'/return-stack',{...body,accountToken:b.token},undefined,403)
  await Promise.all([req('/api/rooms/'+r.roomCode+'/return-stack',body),req('/api/rooms/'+r.roomCode+'/return-stack',body)])
  assert.equal((await state(r)).players.find((x:any)=>x.id===p.playerId).stack,750)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:a.id}})).balance,before.balance+250n)
  const entries=await db.walletLedgerEntry.findMany({where:{entryType:'ROOM_STACK_RETURN',wallet:{userId:a.id}}})
  assert.equal(entries.length,1);assert.equal((entries[0]!.metadata as any).roomCode,r.roomCode)
  const mirrors=await db.roomLedgerEntry.findMany({where:{transferId:entries[0]!.transferId}})
  assert.equal(mirrors.reduce((sum,e)=>sum+e.amount,entries[0]!.amount),0n)
  await command(r,'start-game');await command(r,'start-hand')
  await req('/api/rooms/'+r.roomCode+'/return-stack',body)
  await req('/api/rooms/'+r.roomCode+'/return-stack',{...body,clientRequestId:randomUUID()},undefined,409)
  await command(r,'delete')
})
test('three tokens, redistribution, anonymous dealer totals, first-action lock and conserved winner fund',async()=>{
  const a=await account(),b=await account(),c=await account(),d=await account(),r=await room()
  const pa=await join(r,a),pb=await join(r,b);await join(r,c,'spectator');await join(r,d,'spectator')
  await command(r,'start-game');await command(r,'start-hand')
  const path='/api/rooms/'+r.roomCode+'/tokens/'
  const view=await req(path+'state',undefined,c.token)
  assert.equal(view.budget,3);assert.equal(view.remaining,3)
  const allocate=(u:any,allocations:any[],status=200,requestId=randomUUID())=>req(path+'allocate',{roundId:view.round.id,requestId,allocations},u.token,status)
  await allocate(a,[{candidateId:pa.playerId,tokens:1}],400)
  await allocate(c,[{candidateId:pa.playerId,tokens:3},{candidateId:pb.playerId,tokens:1}],400)
  await allocate(c,[{candidateId:pb.playerId,tokens:1}])
  const key=randomUUID()
  await allocate(c,[{candidateId:pa.playerId,tokens:3}],200,key)
  await allocate(c,[{candidateId:pa.playerId,tokens:3}],200,key)
  await allocate(d,[{candidateId:pa.playerId,tokens:1}])
  const dealer=await req(path+'dealer',undefined,r.dealerSecret)
  assert.equal(dealer.round.candidates.find((x:any)=>x.id===pa.playerId).tokens,4)
  assert.ok(!JSON.stringify(dealer).includes(c.id) && !JSON.stringify(dealer).includes(c.token))
  const rewardBefore=(await db.walletLedgerEntry.aggregate({where:{entryType:'ACHIEVEMENT_REWARD'},_sum:{amount:true}}))._sum.amount || 0n
  const walletBefore=(await db.userWallet.aggregate({_sum:{balance:true}}))._sum.balance!
  const pokerBefore=(await state(r)).players.reduce((sum:number,p:any)=>sum+p.stack+p.totalCommitted,0)
  // Raise net profit enough for meaningful floor split.
  await req('/api/rooms/'+r.roomCode+'/action',{playerId:pa.playerId,token:pa.playerSessionToken,type:'raise',amount:100,clientRequestId:randomUUID()})
  await allocate(c,[],409)
  await act(r,pb,'call')
  const players=new Map([[pa.playerId,pa],[pb.playerId,pb]])
  for(let i=0;i<20;i++){
    const s=await state(r),phase=s.currentHand.bettingState.phase
    if(phase==='showdown')break
    if(phase==='reveal') await command(r,'reveal-cards',{handId:s.currentHand.id,street:s.currentHand.bettingState.street})
    else await act(r,players.get(s.currentSession.currentPlayerId),'check')
  }
  await command(r,'finish-hand');await command(r,'distribute-pot',{winners:[pa.playerId]})
  const final=await state(r),round=await db.tokenPredictionRound.findUniqueOrThrow({where:{id:view.round.id}})
  assert.equal(round.rewardFund,9n)
  assert.equal(final.players.find((p:any)=>p.id===pa.playerId).stack,1091)
  const walletAfter=(await db.userWallet.aggregate({_sum:{balance:true}}))._sum.balance!
  const rewardAfter=(await db.walletLedgerEntry.aggregate({where:{entryType:'ACHIEVEMENT_REWARD'},_sum:{amount:true}}))._sum.amount || 0n
  const systemRewards=rewardAfter-rewardBefore
  assert.equal(walletAfter-walletBefore-systemRewards,9n)
  assert.equal(final.players.reduce((sum:number,p:any)=>sum+p.stack,0)+Number(walletAfter-walletBefore-systemRewards),pokerBefore)
  await command(r,'distribute-pot',{winners:[pa.playerId]},409)
  assert.equal((await db.userWallet.aggregate({_sum:{balance:true}}))._sum.balance,walletAfter)
  assert.equal((await req(path+'state',undefined,c.token)).history[0].payout,7)
  await command(r,'start-hand')
  const next=await req(path+'state',undefined,c.token);assert.equal(next.remaining,3);assert.equal(next.allocations.length,0)
  await command(r,'delete')
})
test('legacy fixed-odds contracts settle at their original promised payout; new cash bets are retired',async()=>{
  const a=await account(),b=await account(),r=await room(),pa=await join(r,a),pb=await join(r,b)
  await command(r,'start-game');await command(r,'start-hand')
  const s=await state(r),member=s.players.find((p:any)=>p.id===pa.playerId).memberId
  const market=await db.predictionMarket.create({data:{roomId:s.room.id,handId:s.currentHand.id,marketType:'main_pot_single_winner',pricingMode:'fixed_odds',status:'open',liquidity:100n,modelVersion:'fixed-odds-v1',modelSnapshot:{}}})
  await db.predictionWallet.create({data:{roomId:s.room.id,memberId:member,grantRemaining:40n,balance:30n}})
  const bet=await db.predictionBet.create({data:{marketId:market.id,memberId:member,candidatePlayerId:pb.playerId,stake:10n,status:'open',quoteRevision:1,acceptedOddsHundredths:200,potentialPayout:20n,placedStreet:'preflop',clientRequestId:randomUUID()}})
  await req('/api/rooms/'+r.roomCode+'/predictions/'+market.id+'/bet',{accountToken:a.token,memberId:member,candidatePlayerId:pb.playerId,stake:10,clientRequestId:randomUUID(),expectedMarketRevision:1},undefined,410)
  await act(r,pa,'fold');await command(r,'finish-hand');await command(r,'distribute-pot',{winners:[pb.playerId]})
  const settled=await db.predictionBet.findUniqueOrThrow({where:{id:bet.id}})
  assert.equal(settled.status,'won');assert.equal(settled.grossPayout,20n)
  assert.equal((await db.predictionWallet.findUniqueOrThrow({where:{memberId:member}})).balance,50n)
  await command(r,'delete')
})
test('zero net split winners pay zero; pending first action locks tokens and undo voids round',async()=>{
  const a=await account(),b=await account(),spectator=await account(),r=await room(),pa=await join(r,a),pb=await join(r,b)
  await join(r,spectator,'spectator')
  await command(r,'start-game');await command(r,'start-hand')
  const path='/api/rooms/'+r.roomCode+'/tokens/',view=await req(path+'state',undefined,spectator.token)
  await req(path+'allocate',{roundId:view.round.id,requestId:randomUUID(),allocations:[{candidateId:pa.playerId,tokens:1},{candidateId:pb.playerId,tokens:2}]},spectator.token)
  await act(r,pa,'call')
  const players=new Map([[pa.playerId,pa],[pb.playerId,pb]])
  for(let i=0;i<22;i++){
    const s=await state(r),phase=s.currentHand.bettingState.phase
    if(phase==='showdown') break
    if(phase==='reveal') await command(r,'reveal-cards',{handId:s.currentHand.id,street:s.currentHand.bettingState.street})
    else await act(r,players.get(s.currentSession.currentPlayerId),'check')
  }
  await command(r,'finish-hand');await command(r,'distribute-pot',{winners:[pa.playerId,pb.playerId]})
  assert.equal((await db.tokenPredictionRound.findUniqueOrThrow({where:{id:view.round.id}})).rewardFund,0n)
  await command(r,'start-hand')
  const next=await req(path+'state',undefined,spectator.token),s=await state(r)
  await db.room.update({where:{id:s.room.id},data:{settings:{...s.room.settings,requireDealerActionApproval:true}}})
  await req(path+'allocate',{roundId:next.round.id,requestId:randomUUID(),allocations:[{candidateId:pa.playerId,tokens:3}]},spectator.token)
  const actor=players.get(s.currentSession.currentPlayerId)!
  const result=await act(r,actor,'call')
  assert.equal(result.action.status,'pending')
  await req(path+'allocate',{roundId:next.round.id,requestId:randomUUID(),allocations:[]},spectator.token,409)
  // Cancelling the room expires predictions without awarding anything.
  await command(r,'delete')
  assert.equal((await db.tokenPredictionRound.findUniqueOrThrow({where:{id:next.round.id}})).status,'VOID')
})
after(async()=>{
  await db.tokenPrediction.deleteMany({where:{userId:{in:users}}})
  await db.tokenPredictionCommand.deleteMany({where:{userId:{in:users}}})
  await db.room.deleteMany({where:{code:{in:rooms}}})
  await db.miniGameSession.deleteMany({where:{userId:{in:users}}})
  await db.minesCommitment.deleteMany({where:{userId:{in:users}}})
  await db.user.deleteMany({where:{id:{in:users}}})
  await db.$disconnect()
})
