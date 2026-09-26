import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { doubleBlackjack, getBlackjackState, hitBlackjack, standBlackjack, startBlackjack } from '../server/services/blackjackService'
import { BLACKJACK_RANKS, BLACKJACK_SUITS, blackjackHandValue, createBlackjackDeck, type BlackjackCard } from '../server/utils/blackjack'
import { splitBlackjack } from '../server/services/blackjackService'
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

async function rigSplitRound(roundId: string, playerCards: [BlackjackCard, BlackjackCard], dealerCards: [BlackjackCard, BlackjackCard], draws: BlackjackCard[]) {
  const used = [...playerCards, ...dealerCards, ...draws]
  assert.equal(new Set(used.map(card => card.code)).size, used.length, 'rigged cards must remain unique')
  const deck = createBlackjackDeck()
  const usedCodes = new Set(used.map(card => card.code))
  const shoe = [...playerCards.slice(0, 1), dealerCards[0], playerCards[1], dealerCards[1], ...draws, ...deck.filter(card => !usedCodes.has(card.code))]
  assert.equal(shoe.length, BLACKJACK_RANKS.length * BLACKJACK_SUITS.length)
  await db.blackjackRound.update({ where: { id: roundId }, data: {
    playerCards: playerCards as any,
    dealerCards: dealerCards as any,
    shoe: shoe as any,
    nextCard: 4,
    playerTotal: blackjackHandValue(playerCards).total,
    dealerTotal: blackjackHandValue(dealerCards).total,
    dealerSoft: blackjackHandValue(dealerCards).soft,
    dealerHoleHidden: true,
    playerHands: null,
    activeHandIndex: null
  } })
}

async function playSplitAction(token: string, round: { roundId: string; actionRevision: number }, action: 'HIT' | 'STAND' | 'SPLIT' | 'DOUBLE') {
  const input = { roundId: round.roundId, requestId: randomUUID(), expectedRevision: round.actionRevision }
  if (action === 'HIT') return hitBlackjack(token, input)
  if (action === 'STAND') return standBlackjack(token, input)
  if (action === 'DOUBLE') return doubleBlackjack(token, input)
  return splitBlackjack(token, input)
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
  await assert.rejects(() => hitBlackjack(token, { roundId: randomUUID(), requestId: randomUUID(), expectedRevision: 0 }), (error: any) => error?.statusCode === 404)

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
    hitBlackjack(token, { roundId, requestId: hitRequestId, expectedRevision: 0 }),
    hitBlackjack(token, { roundId, requestId: hitRequestId, expectedRevision: 0 })
  ])
  assert.equal(hitOnce.round.playerCards.length, handBeforeHit + 1)
  assert.equal(hitReplay.round.playerCards.length, handBeforeHit + 1)
  assert.equal(await db.blackjackAction.count({ where: { roundId, requestId: hitRequestId } }), 1)
  assert.equal([hitOnce.replayed, hitReplay.replayed].filter(Boolean).length, 1)

  const beforeSettlement = (await db.userWallet.findUniqueOrThrow({ where: { userId: account.user.id } })).balance
  const actionRequestId = randomUUID()
  const finished = await standBlackjack(token, { roundId, requestId: actionRequestId, expectedRevision: 1 })
  assert.equal(finished.round.status, 'FINISHED')
  assert.equal(finished.round.outcome, 'WIN')
  assert.equal(finished.round.dealerTotal, 18)
  assert.equal(finished.round.dealerHoleHidden, false)
  assert.equal(finished.round.payout, 200)
  assert.equal(finished.round.balance, Number(beforeSettlement + 200n))
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)

  const replayed = await standBlackjack(token, { roundId, requestId: actionRequestId, expectedRevision: 1 })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.round.balance, finished.round.balance)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${roundId}` } }), 1)
  await assert.rejects(() => standBlackjack(token, { roundId, requestId: randomUUID(), expectedRevision: 1 }), (error: any) => error?.statusCode === 409)
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
    hitBlackjack(token, { roundId: raceRoundId, requestId: randomUUID(), expectedRevision: 0 }),
    standBlackjack(token, { roundId: raceRoundId, requestId: randomUUID(), expectedRevision: 0 })
  ])
  assert.ok(concurrentActions.some(result => result.status === 'fulfilled'))
  let raceFinished = await getBlackjackState(token)
  assert.equal(raceFinished.round?.roundId, raceRoundId)
  if (raceFinished.round?.status === 'ACTIVE') {
    await standBlackjack(token, { roundId: raceRoundId, requestId: randomUUID(), expectedRevision: raceFinished.round.actionRevision })
    raceFinished = await getBlackjackState(token)
  }
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
    doubleBlackjack(token, { roundId, requestId, expectedRevision: 0 }),
    doubleBlackjack(token, { roundId, requestId, expectedRevision: 0 })
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
  const pushed = await doubleBlackjack(token, { roundId: pushStart.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
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
  const lost = await doubleBlackjack(token, { roundId: lossStart.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
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
  const hit = await hitBlackjack(hitAccount.token, { roundId: hitRoundId, requestId: randomUUID(), expectedRevision: 0 })
  assert.equal(hit.round.status, 'ACTIVE')
  assert.equal(hit.round.playerCards.length, 3)
  await assert.rejects(
    () => doubleBlackjack(hitAccount.token, { roundId: hitRoundId, requestId: randomUUID(), expectedRevision: hit.round.actionRevision }),
    (error: any) => error?.statusCode === 409
  )
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${hitRoundId}` } }), 0)

  const poorAccount = await createTestAccount()
  const poorRound = await startActiveRound(poorAccount.token)
  const poorWallet = await db.userWallet.findUniqueOrThrow({ where: { userId: poorAccount.user.id } })
  await db.userWallet.update({ where: { id: poorWallet.id }, data: { balance: 99n } })
  await db.user.update({ where: { id: poorAccount.user.id }, data: { balance: 99 } })
  await assert.rejects(
    () => doubleBlackjack(poorAccount.token, { roundId: poorRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 }),
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
    doubleBlackjack(account.token, { roundId: doubleRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 }),
    doubleBlackjack(account.token, { roundId: doubleRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
  ])
  assert.equal(doubleResults.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${doubleRound.round.roundId}` } }), 1)
  const doubleRaceFinal = await db.blackjackRound.findUniqueOrThrow({ where: { id: doubleRound.round.roundId } })
  assert.equal(doubleRaceFinal.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${doubleRound.round.roundId}` } }), doubleRaceFinal.payout > 0n ? 1 : 0)

  const hitRaceRound = await startActiveRound(account.token)
  await rigRound(hitRaceRound.round.roundId, player, dealer, draws)
  const hitRace = await Promise.allSettled([
    doubleBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 }),
    hitBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
  ])
  assert.equal(hitRace.filter(result => result.status === 'fulfilled').length, 1)
  const hitRaceDoubleDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${hitRaceRound.round.roundId}` } })
  const hitRaceDoubleActions = await db.blackjackAction.count({ where: { roundId: hitRaceRound.round.roundId, action: 'DOUBLE' } })
  assert.equal(hitRaceDoubleDebits, hitRaceDoubleActions)
  let hitRaceState = await db.blackjackRound.findUniqueOrThrow({ where: { id: hitRaceRound.round.roundId } })
  if (hitRaceState.status === 'ACTIVE') {
    await standBlackjack(account.token, { roundId: hitRaceRound.round.roundId, requestId: randomUUID(), expectedRevision: hitRaceState.actionRevision })
    hitRaceState = await db.blackjackRound.findUniqueOrThrow({ where: { id: hitRaceRound.round.roundId } })
  }
  assert.equal(hitRaceState.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${hitRaceRound.round.roundId}` } }), hitRaceState.payout > 0n ? 1 : 0)

  const standRaceRound = await startActiveRound(account.token)
  await rigRound(standRaceRound.round.roundId, player, dealer, draws)
  const standRace = await Promise.allSettled([
    doubleBlackjack(account.token, { roundId: standRaceRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 }),
    standBlackjack(account.token, { roundId: standRaceRound.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
  ])
  assert.equal(standRace.filter(result => result.status === 'fulfilled').length, 1)
  const standRaceDoubleDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${standRaceRound.round.roundId}` } })
  const standRaceDoubleActions = await db.blackjackAction.count({ where: { roundId: standRaceRound.round.roundId, action: 'DOUBLE' } })
  assert.equal(standRaceDoubleDebits, standRaceDoubleActions)
  const standRaceFinal = await db.blackjackRound.findUniqueOrThrow({ where: { id: standRaceRound.round.roundId } })
  assert.equal(standRaceFinal.status, 'FINISHED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${standRaceRound.round.roundId}` } }), standRaceFinal.payout > 0n ? 1 : 0)
})

test('split creates two durable hands, serializes turns, hides dealer hole, and settles mixed outcomes once', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const started = await startActiveRound(account.token)
  const pair: [BlackjackCard, BlackjackCard] = [
    { rank: '8', suit: 'S', code: '8S' },
    { rank: '8', suit: 'H', code: '8H' }
  ]
  const dealer: [BlackjackCard, BlackjackCard] = [
    { rank: '10', suit: 'D', code: '10D' },
    { rank: '8', suit: 'C', code: '8C' }
  ]
  await rigSplitRound(started.round.roundId, pair, dealer, [
    { rank: '2', suit: 'D', code: '2D' },
    { rank: '10', suit: 'S', code: '10S' },
    { rank: '10', suit: 'C', code: '10C' }
  ])
  const splitRequestId = randomUUID()
  const split = await splitBlackjack(account.token, { roundId: started.round.roundId, requestId: splitRequestId, expectedRevision: 0 })
  assert.equal(split.round.status, 'ACTIVE')
  assert.equal(split.round.stake, 200)
  assert.equal(split.round.activeHandIndex, 0)
  assert.deepEqual(split.round.splitHands?.map(hand => [hand.stake, hand.status, hand.cards.length]), [[100, 'ACTIVE', 2], [100, 'WAITING', 2]])
  assert.equal(new Set(split.round.splitHands?.flatMap(hand => hand.cards.map(card => card.code))).size, 4)
  assert.equal(split.round.balance, started.round.balance - 100)
  assert.equal(split.round.dealerHoleHidden, true)
  assert.deepEqual(split.round.dealerCards[1], { hidden: true })
  assert.ok(!JSON.stringify(split.round).includes('8C'))
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:split:${started.round.roundId}` } }), 1)

  const splitReplay = await splitBlackjack(account.token, { roundId: started.round.roundId, requestId: splitRequestId, expectedRevision: 0 })
  assert.equal(splitReplay.replayed, true)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:split:${started.round.roundId}` } }), 1)
  let state = split.round
  await assert.rejects(() => doubleBlackjack(account.token, { roundId: state.roundId, requestId: randomUUID(), expectedRevision: state.actionRevision }), (error: any) => error?.statusCode === 409)
  await assert.rejects(() => splitBlackjack(account.token, { roundId: state.roundId, requestId: randomUUID(), expectedRevision: state.actionRevision }), (error: any) => error?.statusCode === 409)
  const hitFirst = await playSplitAction(account.token, state, 'HIT')
  state = hitFirst.round
  assert.equal(state.splitHands?.[0]?.cards.length, 3)
  assert.deepEqual(state.splitHands?.map(hand => hand.status), ['ACTIVE', 'WAITING'])
  assert.equal(state.splitHands?.[1]?.cards.length, 2, 'a hit only changes the server-selected active hand')
  const standFirst = await playSplitAction(account.token, state, 'STAND')
  state = standFirst.round
  assert.equal(state.activeHandIndex, 1)
  assert.equal(state.splitHands?.[0]?.status, 'STOOD')
  assert.equal(state.splitHands?.[1]?.status, 'ACTIVE')
  assert.equal(state.dealerHoleHidden, true)
  const restored = await getBlackjackState(account.token)
  assert.equal(restored.round?.activeHandIndex, 1)
  assert.deepEqual(restored.round?.splitHands, state.splitHands)
  const standSecond = await playSplitAction(account.token, restored.round!, 'STAND')
  assert.equal(standSecond.round.status, 'FINISHED')
  assert.equal(standSecond.round.dealerCards.length, 2, 'dealer already has 17 and is played exactly once')
  assert.equal(standSecond.round.dealerHoleHidden, false)
  assert.deepEqual(standSecond.round.splitHands?.map(hand => hand.result), ['WIN', 'PUSH'])
  assert.deepEqual(standSecond.round.splitHands?.map(hand => hand.payout), [200, 100])
  assert.equal(standSecond.round.payout, 300)
  assert.equal(standSecond.round.netChange, 100)
  assert.equal(standSecond.round.balance, started.round.balance + 200)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${started.round.roundId}` } }), 1)
  assert.equal(await db.blackjackAction.count({ where: { roundId: started.round.roundId, action: 'SPLIT' } }), 1)
})

test('split rejects unlike ranks or insufficient funds and split aces auto-finish at ordinary 1:1', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const unlike = await startActiveRound(account.token)
  await rigSplitRound(unlike.round.roundId, [
    { rank: 'K', suit: 'S', code: 'KS' }, { rank: 'Q', suit: 'H', code: 'QH' }
  ], [
    { rank: '10', suit: 'D', code: '10D' }, { rank: '6', suit: 'C', code: '6C' }
  ], [])
  await assert.rejects(() => splitBlackjack(account.token, { roundId: unlike.round.roundId, requestId: randomUUID(), expectedRevision: 0 }), (error: any) => error?.statusCode === 409)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:split:${unlike.round.roundId}` } }), 0)

  const poorAccount = await createTestAccount()
  const poor = await startActiveRound(poorAccount.token)
  await rigSplitRound(poor.round.roundId, [
    { rank: '9', suit: 'S', code: '9S' }, { rank: '9', suit: 'H', code: '9H' }
  ], [
    { rank: '10', suit: 'D', code: '10D' }, { rank: '6', suit: 'C', code: '6C' }
  ], [])
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: poorAccount.user.id } })
  await db.userWallet.update({ where: { id: wallet.id }, data: { balance: 50n } })
  await db.user.update({ where: { id: poorAccount.user.id }, data: { balance: 50 } })
  await assert.rejects(() => splitBlackjack(poorAccount.token, { roundId: poor.round.roundId, requestId: randomUUID(), expectedRevision: 0 }), (error: any) => error?.statusCode === 409)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { id: wallet.id } })).balance, 50n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:split:${poor.round.roundId}` } }), 0)
  await db.userWallet.update({ where: { id: wallet.id }, data: { balance: 5000n } })
  await db.user.update({ where: { id: poorAccount.user.id }, data: { balance: 5000 } })

  const acesAccount = await createTestAccount()
  const aces = await startActiveRound(acesAccount.token)
  await rigSplitRound(aces.round.roundId, [
    { rank: 'A', suit: 'S', code: 'AS' }, { rank: 'A', suit: 'H', code: 'AH' }
  ], [
    { rank: '10', suit: 'D', code: '10D' }, { rank: '8', suit: 'C', code: '8C' }
  ], [
    { rank: 'K', suit: 'S', code: 'KS' }, { rank: 'Q', suit: 'H', code: 'QH' }
  ])
  const splitAces = await splitBlackjack(acesAccount.token, { roundId: aces.round.roundId, requestId: randomUUID(), expectedRevision: 0 })
  assert.equal(splitAces.round.status, 'FINISHED')
  assert.equal(splitAces.round.activeHandIndex, null)
  assert.equal(splitAces.round.splitHands?.every(hand => hand.cards.length === 2 && hand.total === 21), true)
  assert.deepEqual(splitAces.round.splitHands?.map(hand => hand.result), ['WIN', 'WIN'])
  assert.deepEqual(splitAces.round.splitHands?.map(hand => hand.payout), [200, 200])
  assert.equal(splitAces.round.payout, 400, 'split 21 returns normal 1:1 winnings and never natural 3:2')
  assert.equal(splitAces.round.dealerCards.length, 2)
})

test('split bust advances to hand two, settles all-bust without dealer draws, and mixed outcomes are per-hand', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const pair: [BlackjackCard, BlackjackCard] = [
    { rank: '8', suit: 'S', code: '8S' }, { rank: '8', suit: 'H', code: '8H' }
  ]
  const dealer17: [BlackjackCard, BlackjackCard] = [
    { rank: '10', suit: 'D', code: '10D' }, { rank: '7', suit: 'C', code: '7C' }
  ]
  const started = await startActiveRound(account.token)
  await rigSplitRound(started.round.roundId, pair, dealer17, [
    { rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'S', code: '10S' },
    { rank: '5', suit: 'D', code: '5D' }
  ])
  let current = (await splitBlackjack(account.token, { roundId: started.round.roundId, requestId: randomUUID(), expectedRevision: 0 })).round
  current = (await playSplitAction(account.token, current, 'HIT')).round
  assert.equal(current.splitHands?.[0]?.status, 'BUST')
  assert.equal(current.activeHandIndex, 1)
  assert.equal(current.splitHands?.[1]?.status, 'ACTIVE')
  assert.equal(current.dealerHoleHidden, true)
  const final = await playSplitAction(account.token, current, 'STAND')
  assert.deepEqual(final.round.splitHands?.map(hand => hand.result), ['BUST', 'WIN'])
  assert.equal(final.round.payout, 200)
  assert.equal(final.round.dealerCards.length, 2)

  const allBust = await startActiveRound(account.token)
  await rigSplitRound(allBust.round.roundId, pair, dealer17, [
    { rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'S', code: '10S' },
    { rank: '5', suit: 'D', code: '5D' }, { rank: '5', suit: 'H', code: '5H' }
  ])
  let bustState = (await splitBlackjack(account.token, { roundId: allBust.round.roundId, requestId: randomUUID(), expectedRevision: 0 })).round
  bustState = (await playSplitAction(account.token, bustState, 'HIT')).round
  bustState = (await playSplitAction(account.token, bustState, 'HIT')).round
  const bothBusted = { round: bustState }
  assert.equal(bothBusted.round.status, 'FINISHED')
  assert.deepEqual(bothBusted.round.splitHands?.map(hand => hand.result), ['BUST', 'BUST'])
  assert.equal(bothBusted.round.payout, 0)
  assert.equal(bothBusted.round.dealerCards.length, 2, 'dealer hole is revealed without drawing when both hands bust')
  assert.equal(bothBusted.round.dealerHoleHidden, false)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${allBust.round.roundId}` } }), 0)
})

test('split settlement calculates wins, losses, and pushes independently and pays one aggregate credit', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const pair: [BlackjackCard, BlackjackCard] = [
    { rank: '8', suit: 'S', code: '8S' }, { rank: '8', suit: 'H', code: '8H' }
  ]
  const cases = [
    { name: 'WIN+WIN', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '7', suit: 'C', code: '7C' }], draws: [{ rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'H', code: '10H' }], actions: ['STAND', 'STAND'], results: ['WIN', 'WIN'], payout: 400 },
    { name: 'WIN+LOSS', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '7', suit: 'C', code: '7C' }], draws: [{ rank: '10', suit: 'C', code: '10C' }, { rank: '2', suit: 'D', code: '2D' }], actions: ['STAND', 'STAND'], results: ['WIN', 'LOSE'], payout: 200 },
    { name: 'WIN+PUSH', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '8', suit: 'C', code: '8C' }], draws: [{ rank: '2', suit: 'D', code: '2D' }, { rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'H', code: '10H' }], actions: ['HIT', 'STAND', 'STAND'], results: ['WIN', 'PUSH'], payout: 300 },
    { name: 'LOSS+LOSS', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '7', suit: 'C', code: '7C' }], draws: [{ rank: '2', suit: 'D', code: '2D' }, { rank: '3', suit: 'C', code: '3C' }], actions: ['STAND', 'STAND'], results: ['LOSE', 'LOSE'], payout: 0 },
    { name: 'PUSH+PUSH', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '8', suit: 'C', code: '8C' }], draws: [{ rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'H', code: '10H' }], actions: ['STAND', 'STAND'], results: ['PUSH', 'PUSH'], payout: 200 },
    { name: 'LOSS+PUSH', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '8', suit: 'C', code: '8C' }], draws: [{ rank: '2', suit: 'D', code: '2D' }, { rank: '10', suit: 'C', code: '10C' }], actions: ['STAND', 'STAND'], results: ['LOSE', 'PUSH'], payout: 100 },
    { name: 'dealer-once', dealer: [{ rank: '10', suit: 'D', code: '10D' }, { rank: '6', suit: 'C', code: '6C' }], draws: [{ rank: '10', suit: 'C', code: '10C' }, { rank: '10', suit: 'H', code: '10H' }, { rank: '2', suit: 'S', code: '2S' }], actions: ['STAND', 'STAND'], results: ['PUSH', 'PUSH'], payout: 200 }
  ] as const

  for (const scenario of cases) {
    const started = await startActiveRound(account.token)
    await rigSplitRound(started.round.roundId, pair, scenario.dealer as unknown as [BlackjackCard, BlackjackCard], scenario.draws as unknown as BlackjackCard[])
    let state = (await splitBlackjack(account.token, { roundId: started.round.roundId, requestId: randomUUID(), expectedRevision: 0 })).round
    for (const action of scenario.actions) state = (await playSplitAction(account.token, state, action)).round
    assert.equal(state.status, 'FINISHED', `${scenario.name} should settle`)
    assert.deepEqual(state.splitHands?.map(hand => hand.result), scenario.results, scenario.name)
    assert.equal(state.payout, scenario.payout, scenario.name)
    if (scenario.name === 'dealer-once') assert.equal(state.dealerCards.length, 3, 'the shared dealer hand is played once for both hands')
    assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:settlement:${started.round.roundId}` } }), scenario.payout > 0 ? 1 : 0)
  }
})

test('SPLIT action revision rejects stale concurrent HIT, STAND, DOUBLE, and a second SPLIT', { skip: !isolatedDb }, async () => {
  const account = await createTestAccount()
  const pair: [BlackjackCard, BlackjackCard] = [
    { rank: '8', suit: 'S', code: '8S' }, { rank: '8', suit: 'H', code: '8H' }
  ]
  const dealer: [BlackjackCard, BlackjackCard] = [
    { rank: '10', suit: 'D', code: '10D' }, { rank: '6', suit: 'C', code: '6C' }
  ]
  for (const competing of ['SPLIT', 'HIT', 'STAND', 'DOUBLE'] as const) {
    const raceAccount = await createTestAccount()
    const started = await startActiveRound(raceAccount.token)
    await rigSplitRound(started.round.roundId, pair, dealer, [
      { rank: '2', suit: 'D', code: '2D' }, { rank: '2', suit: 'C', code: '2C' },
      { rank: '3', suit: 'H', code: '3H' }, { rank: '4', suit: 'H', code: '4H' }
    ])
    const results = await Promise.allSettled([
      splitBlackjack(raceAccount.token, { roundId: started.round.roundId, requestId: randomUUID(), expectedRevision: 0 }),
      playSplitAction(raceAccount.token, { roundId: started.round.roundId, actionRevision: 0 }, competing)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, `SPLIT + ${competing} must have only one winning transition`)
    const splitDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:split:${started.round.roundId}` } })
    const doubleDebits = await db.walletLedgerEntry.count({ where: { idempotencyKey: `blackjack:double:${started.round.roundId}` } })
    assert.equal(splitDebits + doubleDebits, results[0]!.status === 'fulfilled' ? 1 : competing === 'DOUBLE' ? 1 : 0, competing)
    const round = await db.blackjackRound.findUniqueOrThrow({ where: { id: started.round.roundId } })
    assert.ok(round.actionRevision <= 1)
  }
})
