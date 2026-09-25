import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { registerUser } from '../server/services/userAccountService'
import { minesField, minesLimit, minesTerms } from '../server/utils/minesMath'
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
  const achievements=await db.walletLedgerEntry.aggregate({where:{entryType:'ACHIEVEMENT_REWARD'},_sum:{amount:true}})
  const active=await db.miniGameSession.findMany({where:{game:'mines',status:'ACTIVE'},select:{stake:true}})
  const economy=await db.miniGameEconomy.findUnique({where:{id:'global'}})
  // Mines' daily pool is the payout bank; active stakes remain in-flight.
  // Achievement rewards are independent intentional emissions.
  const walletTotal=(wallets._sum.balance || 0n)-(achievements._sum.amount || 0n)
  return walletTotal*10n+(economy?.minesBank ?? 2_000_000n)*10n+(economy?.jackpotTenths ?? 0n)+active.reduce((sum,s)=>sum+s.stake*10n,0n)
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
  return {mine:mines[0]!,safe:Array.from({length:25},(_,i)=>i).filter(i=>!mines.includes(i))}
}
let house:{id:string;token:string}
test('Mines start reserve, restore, concurrent safe open and double cashout conserve chips',async()=>{
  house=await account('SUPERADMIN',5_000_000)
  const user=await account()
  const before=await total()
  const {input,session}=await start(user)
  assert.equal(await total(),before)
  const stored=await db.miniGameSession.findUniqueOrThrow({where:{id:session.id}})
  assert.equal(stored.bankReserve,stored.maxPayout)
  assert.equal(await db.walletLedgerEntry.count({where:{idempotencyKey:'mines:bank-reserve:'+session.id}}),0)
  assert.equal(((await db.walletLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:'mines:stake:'+session.id}})).metadata as any).reserveSource,'MINES_ECONOMY')
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
test('Mines accepts a full-wallet stake once and rejects a stake above the current wallet',async()=>{
  if(!house) house=await account('SUPERADMIN',5_000_000)
  const tenChipUser = await account('USER',15_000)
  const tenChip = await start(tenChipUser,{stake:10,clientSeed:'ten-chip-stake'})
  assert.equal(tenChip.session.stake,10)
  assert.equal(tenChip.session.balance,14_990)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:tenChipUser.id}})).balance,14_990n)
  assert.equal((await req('/api/mines/start',tenChip.input,tenChipUser.token)).session.id,tenChip.session.id)
  assert.equal(await db.walletLedgerEntry.count({where:{idempotencyKey:'mines:stake:'+tenChip.session.id}}),1)
  await req('/api/mines/open',{sessionId:tenChip.session.id,cell:(await cells(tenChip.session.id)).mine},tenChipUser.token)

  const user=await account('USER',12_347)
  const minesState=await req('/api/mines/state',undefined,user.token)
  assert.equal(minesState.minStake,1)
  assert.equal(minesState.maxStake,12_347)
  const {input,session}=await start(user,{stake:12_347})
  assert.equal(session.stake,12_347)
  assert.equal(session.balance,0)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance,0n)
  assert.equal(await db.miniGameSession.count({where:{id:session.id,userId:user.id,status:'ACTIVE',stake:12_347n}}),1)
  assert.equal(await db.walletLedgerEntry.count({where:{idempotencyKey:'mines:stake:'+session.id,amount:-12_347n}}),1)
  assert.equal((await req('/api/mines/start',input,user.token)).session.id,session.id)
  assert.equal(await db.walletLedgerEntry.count({where:{idempotencyKey:'mines:stake:'+session.id}}),1)

  const commitment=await req('/api/mines/prepare',{},user.token)
  const response=await req('/api/mines/start',{...input,stake:12_348,commitmentId:commitment.commitmentId,idempotencyKey:randomUUID()},user.token,409)
  assert.equal(response.statusMessage,'Недостаточно фишек на балансе')
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance,0n)

  const lowStakeUser=await account('USER',1)
  const lowStake=await start(lowStakeUser,{stake:1,clientSeed:'minimum-positive-stake'})
  assert.equal(lowStake.session.stake,1)
  assert.equal(lowStake.session.balance,0)
  assert.equal((await db.walletLedgerEntry.findUniqueOrThrow({where:{idempotencyKey:'mines:stake:'+lowStake.session.id}})).amount,-1n)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:lowStakeUser.id}})).balance,0n)
  await req('/api/mines/open',{sessionId:lowStake.session.id,cell:(await cells(lowStake.session.id)).mine},lowStakeUser.token)
})
test('concurrent Mines bets serialize against the latest wallet and preserve active-round protection',async()=>{
  if(!house) house=await account('SUPERADMIN',5_000_000)
  const user=await account('USER',10_000)
  const commitments=await Promise.all([req('/api/mines/prepare',{},user.token),req('/api/mines/prepare',{},user.token)])
  const inputs=commitments.map((commitment,index)=>({stake:8_000,mines:5,clientSeed:'concurrent-'+index,commitmentId:commitment.commitmentId,idempotencyKey:randomUUID()}))
  const responses=await Promise.all(inputs.map(input=>fetch(base+'/api/mines/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify(input)})))
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409])
  const success=responses.find(response=>response.status===200)!
  const rejected=responses.find(response=>response.status===409)!
  const {session}=await success.json()
  const rejection=await rejected.json()
  assert.match(rejection.statusMessage,/Недостаточно фишек|баланс/)
  assert.equal(session.stake,8_000)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance,2_000n)
  assert.equal(await db.miniGameSession.count({where:{userId:user.id,game:'mines',status:'ACTIVE'}}),1)
  assert.equal(await db.walletLedgerEntry.count({where:{entryType:'MINES_STAKE',wallet:{userId:user.id}}}),1)
  assert.ok((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance>=0n)

  const next=await req('/api/mines/prepare',{},user.token)
  const activeRound=await req('/api/mines/start',{stake:1,mines:5,clientSeed:'active-protection',commitmentId:next.commitmentId,idempotencyKey:randomUUID()},user.token,409)
  assert.match(activeRound.statusMessage,/Сначала завершите текущую игру/)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance,2_000n)
  assert.equal(await db.walletLedgerEntry.count({where:{entryType:'MINES_STAKE',wallet:{userId:user.id}}}),1)
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
  const other=await account()
  const parallelBefore=await total()
  const [parallelA,parallelB]=await Promise.all([start(user,{clientSeed:'parallel-a'}),start(other,{clientSeed:'parallel-b'})])
  assert.equal(await total(),parallelBefore)
  await req('/api/mines/open',{sessionId:parallelA.session.id,cell:(await cells(parallelA.session.id)).mine},user.token)
  await req('/api/mines/open',{sessionId:parallelB.session.id,cell:(await cells(parallelB.session.id)).mine},other.token)
  assert.equal(await total(),parallelBefore)
})
test('bank cannot promise uncovered payout and max payout automatically cashes out',async()=>{
  if(!house) house=await account('SUPERADMIN',5_000_000)
  const user=await account()
  const original=await db.userWallet.findUniqueOrThrow({where:{userId:house.id}})
  await db.userWallet.update({where:{userId:house.id},data:{balance:1n}})
  const commit=await req('/api/mines/prepare',{},user.token),input={stake:100,mines:10,clientSeed:'cap',commitmentId:commit.commitmentId,idempotencyKey:randomUUID()}
  const before=await total()
  const rejected=await req('/api/mines/start',input,user.token,409)
  assert.match(rejected.statusMessage,/Игра временно недоступна/)
  assert.equal((await db.userWallet.findUniqueOrThrow({where:{userId:user.id}})).balance,5_000n)
  assert.equal(await db.miniGameSession.count({where:{userId:user.id,game:'mines',status:'ACTIVE'}}),0)
  assert.equal(await db.walletLedgerEntry.count({where:{entryType:'MINES_STAKE',wallet:{userId:user.id}}}),0)
  assert.equal(await total(),before)
  await db.userWallet.update({where:{userId:house.id},data:{balance:original.balance}})
  const baseline=await total(),{session}=await req('/api/mines/start',input,user.token),{safe}=await cells(session.id)
  let current=session
  for(const safeCell of safe){current=(await req('/api/mines/open',{sessionId:session.id,cell:safeCell},user.token)).session;if(current.status!=='ACTIVE')break}
  assert.equal(current.status,'CASHED_OUT');assert.equal(current.payout,Number(minesTerms(100n,10,current.safeOpened,1_000_000n).payout))
  assert.equal(await total(),baseline)
  const exactReserve=minesLimit(100n,10)
  await db.userWallet.update({where:{userId:house.id},data:{balance:exactReserve}})
  const exactBaseline=await total(),exactGame=await start(user,{clientSeed:'exact-reserve-boundary'})
  const exactStored=await db.miniGameSession.findUniqueOrThrow({where:{id:exactGame.session.id}})
  assert.equal(exactStored.bankReserve,exactReserve)
  assert.equal(await total(),exactBaseline)
  await req('/api/mines/open',{sessionId:exactGame.session.id,cell:(await cells(exactGame.session.id)).mine},user.token)
  assert.equal(await total(),exactBaseline)
  await db.userWallet.update({where:{userId:house.id},data:{balance:original.balance}})
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
