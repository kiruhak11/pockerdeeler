import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { getBlackjackState, hitBlackjack, standBlackjack, startBlackjack } from '../server/services/blackjackService'
import { createBlackjackDeck, type BlackjackCard } from '../server/utils/blackjack'
import { registerUser } from '../server/services/userAccountService'

const databaseUrl = process.env.DATABASE_URL || ''
const isolatedDb = /(?:127\.0\.0\.1:55439\/|_test(?:$|[?]))/.test(databaseUrl)
const db = new PrismaClient()
const createdUsers: string[] = []

after(async () => {
  if (createdUsers.length) await db.user.deleteMany({ where: { id: { in: createdUsers } } })
  await db.$disconnect()
})

test('blackjack stake, durable state, hidden hole card, active-round guard, and idempotent settlement', { skip: !isolatedDb }, async () => {
  const account = await registerUser({ username: `bj_${randomUUID().slice(0, 12)}`, password: 'Isolated-blackjack-test' })
  createdUsers.push(account.user.id)
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
