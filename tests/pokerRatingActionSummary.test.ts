import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBettingAction } from '../server/utils/pokerBetting'
import { advanceStreet, startHand, type HandStartPlayer, type InternalHandState } from '../server/utils/pokerHandState'
import { createStandardDeck } from '../server/utils/pokerDeck'
import { calculateTableRatingChange } from '../app/utils/ratingCalculations'
import { getOnlineHandRatingActionFacts } from '../server/services/onlinePokerRatingService'
import {
  createOnlineRoom,
  joinOnlineRoom,
  setOnlineRoomReady,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState
} from '../server/utils/pokerOnlineRoom'
import { deserializeOnlineRoomRuntimeState, serializeOnlineRoomRuntimeState } from '../server/services/onlineRoomRuntimeStore'

function start(players: readonly HandStartPlayer[] = [
  { playerId: 'a', seat: 1, stack: 300 },
  { playerId: 'b', seat: 2, stack: 300 },
  { playerId: 'c', seat: 3, stack: 300 }
]): InternalHandState {
  return startHand({ players, smallBlind: 5, bigBlind: 10, deck: createStandardDeck() })
}

function apply(state: InternalHandState, type: 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all-in', amount?: number): InternalHandState {
  const player = state.players.find(candidate => candidate.seat === state.currentActor)
  assert.ok(player, `expected actor at ${state.currentActor}`)
  return applyBettingAction(state, { playerId: player.playerId, type, ...(amount === undefined ? {} : { amount }) })
}

function finishRoundWithCalls(state: InternalHandState): InternalHandState {
  let next = state
  while (!next.bettingRoundComplete) {
    const actor = next.players.find(player => player.seat === next.currentActor)
    assert.ok(actor)
    next = apply(next, next.currentBet === actor.streetContribution ? 'check' : 'call')
  }
  return next
}

function finishRoundWithChecks(state: InternalHandState): InternalHandState {
  let next = state
  while (!next.bettingRoundComplete) next = apply(next, 'check')
  return next
}

function runToShowdown(state: InternalHandState): InternalHandState {
  let next = state
  while (next.street !== 'SHOWDOWN') {
    next = finishRoundWithCalls(next)
    next = advanceStreet(next)
  }
  return next
}

test('preflop raise is retained through later streets and rating uses the existing raise rule', () => {
  let hand = start()
  const raiserId = hand.players.find(player => player.seat === hand.currentActor)!.playerId
  hand = apply(hand, 'raise', 30)
  hand = finishRoundWithCalls(hand)
  hand = advanceStreet(hand)
  assert.ok(hand.players.every(player => player.lastAction === null))
  assert.equal(hand.actionSummary.find(summary => summary.playerId === raiserId)?.hadRaise, true)
  hand = runToShowdown(hand)
  const summary = hand.actionSummary.find(item => item.playerId === raiserId)!
  assert.equal(summary.hadRaise, true)
  const facts = getOnlineHandRatingActionFacts(hand, raiserId)
  assert.deepEqual(facts, { hadAction: true, hadRaise: true, hadAllIn: false })
  assert.equal(calculateTableRatingChange({ won: true, split: false, folded: false, ...facts }).delta, 14)
})

test('preflop all-in survives automatic runout and affects the existing rating outcome', () => {
  let hand = start([{ playerId: 'a', seat: 1, stack: 20 }, { playerId: 'b', seat: 2, stack: 20 }])
  hand = apply(hand, 'all-in')
  hand = finishRoundWithCalls(hand)
  hand = advanceStreet(hand)
  assert.equal(hand.street, 'SHOWDOWN')
  assert.equal(hand.players.find(player => player.playerId === 'a')?.lastAction, null)
  const summary = hand.actionSummary.find(item => item.playerId === 'a')!
  assert.equal(summary.hadAllIn, true)
  const facts = getOnlineHandRatingActionFacts(hand, 'a')
  assert.deepEqual(facts, { hadAction: true, hadRaise: false, hadAllIn: true })
  assert.deepEqual(calculateTableRatingChange({ won: false, split: false, folded: false, ...facts }), { delta: -10, reason: 'Проигрыш после all-in' })
})

test('postflop raise and turn all-in remain in the same hand summary', () => {
  let hand = start()
  hand = finishRoundWithCalls(hand)
  hand = advanceStreet(hand)
  const bettorId = hand.players.find(player => player.seat === hand.currentActor)!.playerId
  hand = apply(hand, 'bet', 10)
  const raiserId = hand.players.find(player => player.seat === hand.currentActor)!.playerId
  hand = apply(hand, 'raise', 20)
  hand = finishRoundWithCalls(hand)
  hand = advanceStreet(hand)
  const actor = hand.players.find(player => player.seat === hand.currentActor)
  assert.ok(actor)
  hand = apply(hand, 'all-in')
  assert.equal(hand.actionSummary.find(item => item.playerId === actor.playerId)?.hadAllIn, true)
  assert.equal(hand.actionSummary.find(item => item.playerId === bettorId)?.hadRaise, true)
  assert.equal(hand.actionSummary.find(item => item.playerId === raiserId)?.hadRaise, true)
})

test('check-only, call-only, fold, and all-in calls preserve current rating semantics', () => {
  let checks = start()
  checks = finishRoundWithCalls(checks)
  checks = advanceStreet(checks)
  checks = finishRoundWithChecks(checks)
  assert.ok(checks.actionSummary.every(summary => summary.hadAction && !summary.hadRaise && !summary.hadAllIn))

  let calls = start()
  calls = finishRoundWithCalls(calls)
  assert.ok(calls.actionSummary.every(summary => summary.hadAction && !summary.hadRaise && !summary.hadAllIn))

  let folded = start()
  folded = apply(folded, 'fold')
  assert.equal(folded.actionSummary.find(item => item.playerId === 'a')?.hadAction, true)
  assert.equal(folded.actionSummary.find(item => item.playerId === 'a')?.hadRaise, false)

  let allInCall = start([{ playerId: 'a', seat: 1, stack: 10 }, { playerId: 'b', seat: 2, stack: 100 }])
  allInCall = apply(allInCall, 'call')
  assert.equal(allInCall.players.find(player => player.playerId === 'a')?.status, 'ALL_IN')
  assert.equal(allInCall.actionSummary.find(item => item.playerId === 'a')?.hadAllIn, false)
})

test('runtime round-trip and old snapshots preserve safe defaults without exposing summary', () => {
  let room = createOnlineRoom({ roomId: 'room-summary', roomCode: 'AB2345', ownerId: 'a', ownerStack: 300, smallBlind: 5, bigBlind: 10 })
  room = joinOnlineRoom(room, { playerId: 'b', stack: 300, seat: 2 })
  room = setOnlineRoomReady(setOnlineRoomReady(room, 'a', true), 'b', true)
  room = startOnlineRoomHand(room, { deck: createStandardDeck() })
  const actor = room.pokerTable.currentHand!.players.find(player => player.seat === room.pokerTable.currentHand!.currentActor)!
  room = Object.freeze({ ...room, pokerTable: Object.freeze({
    ...room.pokerTable,
    currentHand: applyBettingAction(room.pokerTable.currentHand!, { playerId: actor.playerId, type: 'raise', amount: 30 })
  }) })

  const restored = deserializeOnlineRoomRuntimeState(serializeOnlineRoomRuntimeState(room), room.roomId).state
  assert.deepEqual(restored.pokerTable.currentHand?.actionSummary, room.pokerTable.currentHand?.actionSummary)
  const safeJson = JSON.stringify(toPlayerSafeOnlineRoomState(restored, 'a'))
  assert.equal(safeJson.includes('actionSummary'), false)

  const parsed = JSON.parse(serializeOnlineRoomRuntimeState(room)) as { state: Record<string, any> }
  const legacyHand = parsed.state.pokerTable.currentHand
  delete legacyHand.actionSummary
  const legacy = deserializeOnlineRoomRuntimeState(JSON.stringify(parsed), room.roomId).state.pokerTable.currentHand!
  assert.ok(legacy.actionSummary.every(summary => typeof summary.hadAction === 'boolean'))
  assert.equal(legacy.actionSummary.find(summary => summary.playerId === actor.playerId)?.hadRaise, true)
})

test('new hand starts with a fresh action summary', () => {
  const hand = start()
  assert.ok(hand.actionSummary.every(summary => !summary.hadAction && !summary.hadRaise && !summary.hadAllIn))
})
