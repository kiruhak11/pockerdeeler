import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { doubleBlackjack, getBlackjackState, hitBlackjack, standBlackjack, startBlackjack } from '../server/services/blackjackService'
import { blackjackHandValue, createBlackjackDeck, type BlackjackCard } from '../server/utils/blackjack'
import { registerUser } from '../server/services/userAccountService'

const databaseUrl = process.env.DATABASE_URL || ''
const isolatedDb = /(?:127\.0\.0\.1:55439\/|_test(?:$|[?]))/.test(databaseUrl)
const db = new PrismaClient()
const createdUsers: string[] = []

async function createTestAccount() {
  const account = await registerUser({ username: `bj_${randomUUID().slice(0, 12)}`, password: 'Isolated-blackjack-test' })
  createdUsers.push(account.user.id)
  return account
}

async function startActiveRound(token: string, stake = 100) {
  let result = await startBlackjack(token, { stake, requestId: randomUUID() })
  for (let attempt = 0; result.round.status !== 'ACTIVE' && attempt < 50; attempt += 1) {
    result = await startBlackjack(token, { stake, requestId: randomUUID() })
  }
  assert.equal(result.round.status, 'ACTIVE', 'a non-natural initial deal should be available')
  return result
}

async function rigRound(roundId: string, playerCards: BlackjackCard[], dealerCards: BlackjackCard[], drawCards: BlackjackCard[]) {
  const shoe = createBlackjackDeck()
  drawCards.forEach((card, index) => { shoe[4 + index] = card })
  await db.blackjackRound.update({ where: { id: roundId }, data: {
    playerCards: playerCards as any,
    dealerCards: dealerCards as any,
    shoe: shoe as any,
    nextCard: 4,
    playerTotal: blackjackHandValue(playerCards).total,
    dealerTotal: blackjackHandValue(dealerCards).total,
    dealerSoft: blackjackHandValue(dealerCards).soft,
    dealerHoleHidden: true
  } })
}

after(async () => {
  if (createdUsers.length) await db.user.deleteMany({ where: { id: { in: createdUsers } } })
  await db.$disconnect()
})

test('blackjack stake, durable state, hidden hole card, active-round guard, and idempotent settlement', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const token = account.token
  assert.deepEqual(await getBlackjackState(token), { round: null, balance: 5000 })
  await assert.rejects(() => startBlackjack(token, { stake: 6000, requestId: randomUUID() }), (error: any) => error?.statusCode === 409)
  await assert.rejects(() => hitBlackjack(token, { roundId: randomUUID(), requestId: randomUUID() }), (error: any) => error?.statusCode === 404)

  const firstRequestId = randomUUID()
  const [startedResult, repeatedStart] = await Promise.all([
    startBlackjack(token, { stake: 100, requestId: firstRequestId }),
    startBlackjack(token, { stake: 100, requestId: firstRequestId })
  ])
  let started = startedResult
  assert.equal(repeatedStart.round.roundId, started.round.roundId)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:stake:${started.round.roundId}` } }), 1)

  for (let attempt = 0; started.round.status !== 'ACTIVE' && attempt < 20; attempt += 1) {
    started = await startBlackjack(token, { stake: 100, requestId: randomUUID() })
  }
  assert.equal(started.round.status, 'ACTIVE', 'a non-natural initial deal should be available')
  const roundId = started.round.roundId
  const forcedPlayer: BlackjackCard[] = [{ rank: 'Q', suit: 'H', code: 'QH' }, { rank: '8', suit: 'S', code: '8S' }]
  const forcedDealer: BlackjackCard[] = [{ rank: '10', suit: 'D', code: '10D' }, { rank: '5', suit: 'C', code: '5C' }]
  const shoe = createBlackjackDeck()
  shoe[4] = { rank: '2', suit: 'C', code: '2C' }
  shoe[5] = { rank: '3', suit: 'D', code: '3D' }
  await db.blackjackRound.update({ where: { id: roundId }, data: { playerCards: forcedPlayer as any, dealerCards: forcedDealer as any, shoe: shoe as any, nextCard: 4, playerTotal: 18, dealerTotal: 15, dealerSoft: false, dealerHoleHidden: true } })

  const restored = await getBlackjackState(token)
  assert.equal(restored.round?.roundId, roundId)
  assert.equal(restored.round?.dealerHoleHidden, true)
  assert.deepEqual(restored.round?.dealerCards[1], { hidden: true })
  assert.ok(!JSON.stringify(restored.round).includes('5C'))
  await assert.rejects(() => startBlackjack(token, { stake: 100, requestId: randomUUID() }), (error: any) => error?.statusCode === 409)

  const hitRequestId = randomUUID()
  const handBeforeHit = started.round.playerCards.length
  const [hitOnce, hitReplay] = await Promise.all([
    hitBlackjack(token, { roundId, requestId: hitRequestId }),
    hitBlackjack(token, { roundId, requestId: hitRequestId })
  ])
  assert.equal(hitOnce.round.playerCards.length, handBeforeHit + 1)
  assert.equal(hitReplay.round.playerCards.length, handBeforeHit + 1)
  assert.equal(await db.blackjackAction.count({ where: { roundId, requestId: hitRequestId } }), 1)
  assert.equal(hitReplay.replayed, true)

  const beforeSettlement = (await db.userWallet.findUniqueOrThrow({ where: { userId: account.user.id } })).balance
  const actionRequestId = randomUUID()
  const finished = await standBlackjack(token, { roundId, requestId: actionRequestId })
  assert.equal(finished.round.status, 'FINISHED')
  assert.equal(finished.round.outcome, 'WIN')
  assert.equal(finished.round.dealerTotal, 18)
  assert.equal(finished.round.dealerHoleHidden, false)
  assert.equal(finished.round.payout, 200)
  assert.equal(finished.round.balance, Number(beforeSettlement + 200n))
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)

  const replayed = await standBlackjack(token, { roundId, requestId: actionRequestId })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.round.balance, finished.round.balance)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)
  await assert.rejects(() => standBlackjack(token, { roundId, requestId: randomUUID() }), (error: any) => error?.statusCode === 409)
  assert.equal((await getBlackjackState(token)).round?.outcome, 'WIN')

  let raceStart = await startBlackjack(token, { stake: 100, requestId: randomUUID() })
  for (let attempt = 0; raceStart.round.status !== 'ACTIVE' && attempt < 20; attempt += 1) {
    raceStart = await startBlackjack(token, { stake: 100, requestId: randomUUID() })
  }
  assert.equal(raceStart.round.status, 'ACTIVE')
  const raceRoundId = raceStart.round.roundId
  const raceShoe = createBlackjackDeck()
  raceShoe[4] = { rank: '2', suit: 'C', code: '2C' }
  raceShoe[5] = { rank: '3', suit: 'D', code: '3D' }
  await db.blackjackRound.update({ where: { id: raceRoundId }, data: {
    playerCards: forcedPlayer as any, dealerCards: forcedDealer as any, shoe: raceShoe as any,
    nextCard: 4, playerTotal: 18, dealerTotal: 15, dealerSoft: false, dealerHoleHidden: true
  } })
  const concurrentActions = await Promise.allSettled([
    hitBlackjack(token, { roundId: raceRoundId, requestId: randomUUID() }),
    standBlackjack(token, { roundId: raceRoundId, requestId: randomUUID() })
  ])
  assert.ok(concurrentActions.some(result => result.status === 'fulfilled'))
  const raceFinished = await getBlackjackState(token)
  assert.equal(raceFinished.round?.roundId, raceRoundId)
  assert.equal(raceFinished.round?.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${raceRoundId}` } }), 1)
})

test('double down settles exactly once on the doubled stake and survives refresh', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const token = account.token
  const started = await startActiveRound(token)
  const roundId = started.round.roundId
  const player: BlackjackCard[] = [
    { rank: '10', suit: 'H', code: '10H' },
    { rank: '6', suit: 'S', code: '6S' }
  ]
  const dealer: BlackjackCard[] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '6', suit: 'C', code: '6C' }
  ]
  await rigRound(roundId, player, dealer, [
    { rank: '5', suit: 'H', code: '5H' },
    { rank: '2', suit: 'D', code: '2D' }
  ])
  const beforeDoubleState = await getBlackjackState(token)
  assert.equal(beforeDoubleState.round?.dealerHoleHidden, true)
  assert.deepEqual(beforeDoubleState.round?.dealerCards[1], { hidden: true })
  assert.ok(!JSON.stringify(beforeDoubleState.round).includes('6C'))

  const walletBeforeDouble = started.round.balance
  const requestId = randomUUID()
  const [first, retry] = await Promise.all([
    doubleBlackjack(token, { roundId, requestId }),
    doubleBlackjack(token, { roundId, requestId })
  ])
  const settled = first.round
  assert.equal(retry.round.roundId, roundId)
  assert.equal([first.replayed, retry.replayed].filter(Boolean).length, 1)
  assert.equal(settled.status, 'FINISHED')
  assert.equal(settled.doubled, true)
  assert.equal(settled.stake, 200)
  assert.equal(settled.playerCards.length, 3)
  assert.equal('hidden' in settled.playerCards[2] ? null : settled.playerCards[2].code, '5H')
  assert.equal(settled.playerTotal, 21)
  assert.equal(settled.outcome, 'WIN', 'a 21 after double is not a natural blackjack')
  assert.equal(settled.payout, 400)
  assert.equal(settled.dealerTotal, 18)
  assert.equal(settled.dealerCards.length, 3, 'dealer draws automatically after the one double card')
  assert.equal(settled.dealerHoleHidden, false)
  assert.equal(settled.balance, walletBeforeDouble + 300)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${roundId}` } }), 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)
  assert.equal(await db.blackjackAction.count({ where: { roundId, action: 'DOUBLE' } }), 1)

  const restored = await getBlackjackState(token)
  assert.equal(restored.round?.roundId, roundId)
  assert.equal(restored.round?.doubled, true)
  assert.equal(restored.round?.payout, 400)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)

  const pushStart = await startActiveRound(token)
  const pushDealer: BlackjackCard[] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '8', suit: 'C', code: '8C' }
  ]
  await rigRound(pushStart.round.roundId, player, pushDealer, [{ rank: '2', suit: 'C', code: '2C' }])
  const pushed = await doubleBlackjack(token, { roundId: pushStart.round.roundId, requestId: randomUUID() })
  assert.equal(pushed.round.outcome, 'PUSH')
  assert.equal(pushed.round.stake, 200)
  assert.equal(pushed.round.payout, 200)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${pushStart.round.roundId}` } }), 1)

  const lossStart = await startActiveRound(token)
  const lossDealer: BlackjackCard[] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '9', suit: 'C', code: '9C' }
  ]
  await rigRound(lossStart.round.roundId, player, lossDealer, [{ rank: '2', suit: 'C', code: '2C' }])
  const lost = await doubleBlackjack(token, { roundId: lossStart.round.roundId, requestId: randomUUID() })
  assert.equal(lost.round.outcome, 'LOSE')
  assert.equal(lost.round.stake, 200)
  assert.equal(lost.round.payout, 0)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${lossStart.round.roundId}` } }), 0)
})

test('double down rejects after HIT and when locked wallet cannot cover the extra stake', { skip: !isolatedDb }, async () => {
  const hitAccount = await createTestAccount()
  const hitRound = await startActiveRound(hitAccount.token)
  const hitRoundId = hitRound.round.roundId
  const lowPlayer: BlackjackCard[] = [
    { rank: '8', suit: 'H', code: '8H' },
    { rank: '7', suit: 'S', code: '7S' }
  ]
  const lowDealer: BlackjackCard[] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '6', suit: 'C', code: '6C' }
  ]
  await rigRound(hitRoundId, lowPlayer, lowDealer, [
    { rank: '2', suit: 'D', code: '2D' },
    { rank: '2', suit: 'H', code: '2H' }
  ])
  const hit = await hitBlackjack(hitAccount.token, { roundId: hitRoundId, requestId: randomUUID() })
  assert.equal(hit.round.status, 'ACTIVE')
  assert.equal(hit.round.playerCards.length, 3)
  await assert.rejects(
    () => doubleBlackjack(hitAccount.token, { roundId: hitRoundId, requestId: randomUUID() }),
    (error: any) => error?.statusCode === 409
  )
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${hitRoundId}` } }), 0)

  const poorAccount = await createTestAccount()
  const poorRound = await startActiveRound(poorAccount.token)
  const poorWallet = await db.userWallet.findUniqueOrThrow({ where: { userId: poorAccount.user.id } })
  await db.userWallet.update({ where: { id: poorWallet.id }, data: { balance: 99n } })
  await db.user.update({ where: { id: poorAccount.user.id }, data: { balance: 99 } })
  await assert.rejects(
    () => doubleBlackjack(poorAccount.token, { roundId: poorRound.round.roundId, requestId: randomUUID() }),
    (error: any) => error?.statusCode === 409 && error?.statusMessage === 'Недостаточно фишек для удвоения ставки'
  )
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { id: poorWallet.id } })).balance, 99n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${poorRound.round.roundId}` } }), 0)
})

test('double, double race and double against HIT/STAND allow one serialized transition', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const player: BlackjackCard[] = [
    { rank: '10', suit: 'H', code: '10H' },
    { rank: '6', suit: 'S', code: '6S' }
  ]
  const dealer: BlackjackCard[] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '6', suit: 'C', code: '6C' }
  ]
  const draws: BlackjackCard[] = [
    { rank: '2', suit: 'C', code: '2C' },
    { rank: '2', suit: 'D', code: '2D' }
  ]

  const doubleRound = await startActiveRound(account.token)
  await rigRound(doubleRound.round.roundId, player, dealer, draws)
  const doubleResults = await Promise.allSettled([
    doubleBlackjack(account.token, { roundId: doubleRound.round.roundId, requestId: randomUUID() }),
    doubleBlackjack(account.token, { roundId: doubleRound.round.roundId, requestId: randomUUID() })
  ])
  assert.equal(doubleResults.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${doubleRound.round.roundId}` } }), 1)
  const doubleRaceFinal = await db.blackjackRound.findUniqueOrThrow({ where: { id: doubleRound.round.roundId } })
  assert.equal(doubleRaceFinal.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${doubleRound.round.roundId}` } }), doubleRaceFinal.payout > 0n ? 1 : 0)

  const hitRaceRound = await startActiveRound(account.token)
  await rigRound(hitRaceRound.round.roundId, player, dealer, draws)
  const hitRace = await Promise.allSettled([
    doubleBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID() }),
    hitBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID() })
  ])
  assert.equal(hitRace.filter(result => result.status === 'fulfilled').length, 1)
  const hitRaceDoubleDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${hitRaceRound.round.roundId}` } })
  const hitRaceDoubleActions = await db.blackjackAction.count({ where: { roundId: hitRaceRound.round.roundId, action: 'DOUBLE' } })
  assert.equal(hitRaceDoubleDebits, hitRaceDoubleActions)
  let hitRaceState = await db.blackjackRound.findUniqueOrThrow({ where: { id: hitRaceRound.round.roundId } })
  if (hitRaceState.status === 'ACTIVE') {
    await standBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID() })
    hitRaceState = await db.blackjackRound.findUniqueOrThrow({ where: { id: hitRaceRound.round.roundId } })
  }
  assert.equal(hitRaceState.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${hitRaceRound.round.roundId}` } }), hitRaceState.payout > 0n ? 1 : 0)

  const standRaceRound = await startActiveRound(account.token)
  await rigRound(standRaceRound.round.roundId, player, dealer, draws)
  const standRace = await Promise.allSettled([
    doubleBlackjack(account.token, { roundId: standRaceRound.round.roundId, requestId: randomUUID() }),
    standBlackjack(account.token, { roundId: standRaceRound.round.roundId, requestId: randomUUID() })
  ])
  assert.equal(standRace.filter(result => result.status === 'fulfilled').length, 1)
  const standRaceDoubleDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${standRaceRound.round.roundId}` } })
  const standRaceDoubleActions = await db.blackjackAction.count({ where: { roundId: standRaceRound.round.roundId, action: 'DOUBLE' } })
  assert.equal(standRaceDoubleDebits, standRaceDoubleActions)
  const standRaceFinal = await db.blackjackRound.findUniqueOrThrow({ where: { id: standRaceRound.round.roundId } })
  assert.equal(standRaceFinal.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${standRaceRound.round.roundId}` } }), standRaceFinal.payout > 0n ? 1 : 0)
})
