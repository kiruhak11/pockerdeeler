import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getToCall } from '../server/utils/pokerBetting'
import { createPredefinedDeck, createStandardDeck } from '../server/utils/pokerDeck'
import {
  applyTableAction,
  canStartNextHand,
  createPokerTable,
  leavePlayer,
  seatPlayer,
  setPlayerConnected,
  setPlayerReady,
  setPlayerSittingOut,
  startTableHand,
  toPlayerSafeTableState,
  type PokerTableState
} from '../server/utils/pokerTableState'

function deck() {
  return createPredefinedDeck(createStandardDeck().availableCards)
}

function table(): PokerTableState {
  return createPokerTable({ tableId: 'table-test', smallBlind: 5, bigBlind: 10 })
}

function seated(tableState: PokerTableState, count = 2, stack = 100): PokerTableState {
  let next = tableState
  for (let index = 0; index < count; index += 1) {
    next = seatPlayer(next, {
      playerId: `player-${index + 1}`,
      seat: index + 1,
      stack,
      ready: true
    })
  }
  return next
}

function running(tableState = seated(table())): PokerTableState {
  return startTableHand(tableState, { deck: deck() })
}

test('creates an empty six-seat table', () => {
  const state = table()
  assert.equal(state.tableId, 'table-test')
  assert.equal(state.maxPlayers, 6)
  assert.equal(state.status, 'WAITING')
  assert.equal(state.stateVersion, 0)
  assert.equal(state.handSequence, 0)
  assert.equal(state.currentHand, null)
  assert.deepEqual(state.seats, [1, 2, 3, 4, 5, 6].map(seat => ({ seat, playerId: null })))
})

test('seats the first player and increments state version', () => {
  const next = seatPlayer(table(), { playerId: 'a', seat: 3, stack: 100 })
  assert.equal(next.stateVersion, 1)
  assert.deepEqual(next.players, [{ playerId: 'a', seat: 3, stack: 100, connected: true, ready: false, sittingOut: false }])
  assert.equal(next.seats[2]!.playerId, 'a')
})

test('seats multiple players in stable seat order', () => {
  let state = table()
  state = seatPlayer(state, { playerId: 'c', seat: 6, stack: 100 })
  state = seatPlayer(state, { playerId: 'a', seat: 2, stack: 100 })
  state = seatPlayer(state, { playerId: 'b', seat: 4, stack: 100 })
  assert.deepEqual(state.players.map(player => player.playerId), ['a', 'b', 'c'])
  assert.deepEqual(state.players.map(player => player.seat), [2, 4, 6])
})

test('duplicate seat and duplicate player are rejected', () => {
  const state = seatPlayer(table(), { playerId: 'a', seat: 1, stack: 100 })
  assert.throws(() => seatPlayer(state, { playerId: 'b', seat: 1, stack: 100 }), /occupied/)
  assert.throws(() => seatPlayer(state, { playerId: 'a', seat: 2, stack: 100 }), /already seated/)
})

test('table cannot exceed six players or use an invalid seat', () => {
  const state = seated(table(), 6)
  assert.throws(() => seatPlayer(state, { playerId: 'extra', seat: 1, stack: 100 }), /full/)
  assert.throws(() => seatPlayer(table(), { playerId: 'bad', seat: 7, stack: 100 }), /between 1 and 6/)
})

test('leave releases the seat and increments state version', () => {
  const state = seated(table(), 2)
  const next = leavePlayer(state, 'player-1')
  assert.equal(next.stateVersion, state.stateVersion + 1)
  assert.equal(next.players.length, 1)
  assert.equal(next.seats[0]!.playerId, null)
})

test('insufficient eligible players keep the table waiting', () => {
  let state = seatPlayer(table(), { playerId: 'a', seat: 1, stack: 100, ready: true })
  assert.equal(canStartNextHand(state), false)
  const next = startTableHand(state, { deck: deck() })
  assert.equal(next.status, 'WAITING')
  assert.equal(next.currentHand, null)
  assert.equal(next.stateVersion, state.stateVersion)
})

test('ready=false players are excluded until they become ready', () => {
  let state = seatPlayer(table(), { playerId: 'a', seat: 1, stack: 100, ready: true })
  state = seatPlayer(state, { playerId: 'b', seat: 2, stack: 100, ready: false })
  assert.equal(canStartNextHand(state), false)
  state = setPlayerReady(state, 'b', true)
  assert.equal(canStartNextHand(state), true)
  assert.equal(startTableHand(state, { deck: deck() }).currentHand !== null, true)
})

test('sitting-out players are excluded from a new hand', () => {
  let state = seatPlayer(table(), { playerId: 'a', seat: 1, stack: 100, ready: true })
  state = seatPlayer(state, { playerId: 'b', seat: 2, stack: 100, ready: true, sittingOut: true })
  assert.equal(canStartNextHand(state), false)
  state = setPlayerSittingOut(state, 'b', false)
  assert.equal(startTableHand(state, { deck: deck() }).currentHand !== null, true)
})

test('zero-stack players are excluded from hand eligibility', () => {
  let state = seatPlayer(table(), { playerId: 'a', seat: 1, stack: 100, ready: true })
  state = seatPlayer(state, { playerId: 'b', seat: 2, stack: 0, ready: true })
  assert.equal(canStartNextHand(state), false)
})

test('starting a table hand delegates to the existing hand initializer', () => {
  const state = running(seated(table(), 3))
  assert.equal(state.status, 'IN_HAND')
  assert.equal(state.handSequence, 1)
  assert.equal(state.stateVersion, 4)
  assert.ok(state.currentHand)
  assert.equal(state.currentHand.players.length, 3)
  assert.equal(state.currentHand.board.length, 0)
})

test('dealer rotation is preserved across a subsequent hand', () => {
  const first = running(seated(table(), 3))
  const finished = Object.freeze({
    ...first,
    currentHand: Object.freeze({ ...first.currentHand!, street: 'FINISHED' as const, currentActor: null, bettingRoundComplete: true })
  })
  const second = startTableHand(finished, { deck: deck() })
  assert.equal(second.dealerSeat, first.currentHand!.players.map(player => player.seat).sort((a, b) => a - b)[1])
  assert.equal(second.handSequence, 2)
})

test('state version increments on seating, readiness, hand start, and actions', () => {
  let state = table()
  state = seatPlayer(state, { playerId: 'a', seat: 1, stack: 100 })
  state = seatPlayer(state, { playerId: 'b', seat: 2, stack: 100 })
  const beforeReady = state.stateVersion
  state = setPlayerReady(state, 'a', true)
  state = setPlayerReady(state, 'b', true)
  assert.equal(state.stateVersion, beforeReady + 2)
  state = startTableHand(state, { deck: deck() })
  const beforeAction = state.stateVersion
  const actor = state.currentHand!.players.find(player => player.seat === state.currentHand!.currentActor)!
  state = applyTableAction(state, {
    playerId: actor.playerId,
    type: getToCall(state.currentHand!, actor.playerId) > 0 ? 'call' : 'check',
    expectedStateVersion: beforeAction
  })
  assert.equal(state.stateVersion, beforeAction + 1)
})

test('stale table action is rejected without mutating the source state', () => {
  const state = running()
  const actor = state.currentHand!.players.find(player => player.seat === state.currentHand!.currentActor)!
  const before = state
  assert.throws(() => applyTableAction(state, { playerId: actor.playerId, type: 'call', expectedStateVersion: state.stateVersion - 1 }), /Expected table state version/)
  assert.equal(state, before)
  assert.equal(state.currentHand!.currentActor, actor.seat)
})

test('valid table action uses the existing betting engine', () => {
  const state = running()
  const actor = state.currentHand!.players.find(player => player.seat === state.currentHand!.currentActor)!
  const next = applyTableAction(state, {
    playerId: actor.playerId,
    type: getToCall(state.currentHand!, actor.playerId) > 0 ? 'call' : 'check'
  })
  assert.notEqual(next.currentHand, state.currentHand)
  assert.equal(next.stateVersion, state.stateVersion + 1)
  assert.equal(next.players.find(player => player.playerId === actor.playerId)!.stack, next.currentHand!.players.find(player => player.playerId === actor.playerId)!.stack)
})

test('invalid actor is rejected by the existing engine wrapper', () => {
  const state = running()
  const actor = state.currentHand!.players.find(player => player.seat === state.currentHand!.currentActor)!
  const other = state.currentHand!.players.find(player => player.playerId !== actor.playerId)!
  assert.throws(() => applyTableAction(state, { playerId: other.playerId, type: 'call' }), /not this player\'s turn/)
})

test('table operations do not mutate the source state', () => {
  const state = running()
  const hand = state.currentHand
  const actor = hand!.players.find(player => player.seat === hand!.currentActor)!
  const next = applyTableAction(state, { playerId: actor.playerId, type: 'call' })
  assert.equal(state.currentHand, hand)
  assert.equal(state.stateVersion, 3)
  assert.equal(next.stateVersion, 4)
})

test('disconnecting between hands excludes a player without changing the hand state', () => {
  let state = seated(table(), 3)
  state = setPlayerConnected(state, 'player-2', false)
  state = setPlayerReady(state, 'player-1', true)
  state = setPlayerReady(state, 'player-3', true)
  const next = startTableHand(state, { deck: deck() })
  assert.equal(next.currentHand!.players.some(player => player.playerId === 'player-2'), false)
  assert.equal(next.players.find(player => player.playerId === 'player-2')!.connected, false)

  const runningState = running(seated(table(), 3))
  const previousHand = runningState.currentHand
  const disconnected = setPlayerConnected(runningState, 'player-2', false)
  assert.equal(disconnected.currentHand, previousHand)
  assert.equal(disconnected.currentHand!.players.length, 3)
})

test('leave, ready, and sitting-out changes are rejected during a running hand', () => {
  const state = running()
  assert.throws(() => leavePlayer(state, 'player-1'), /active hand/)
  assert.throws(() => setPlayerReady(state, 'player-1', false), /active hand/)
  assert.throws(() => setPlayerSittingOut(state, 'player-1', true), /active hand/)
})

test('short blind all-in is represented in the table and hand stacks', () => {
  const state = running(seated(table(), 2, 3))
  const handPlayer = state.currentHand!.players.find(player => player.seat === state.currentHand!.smallBlindSeat)!
  const tablePlayer = state.players.find(player => player.playerId === handPlayer.playerId)!
  assert.equal(handPlayer.stack, 0)
  assert.equal(handPlayer.status, 'ALL_IN')
  assert.equal(tablePlayer.stack, 0)
})

test('safe snapshot exposes only public hand fields and viewer hole cards', () => {
  const state = running()
  const viewer = state.players[0]!.playerId
  const safe = toPlayerSafeTableState(state, viewer)
  assert.equal(safe.stateVersion, state.stateVersion)
  assert.equal(safe.currentHand!.players.find(player => player.playerId === viewer)!.holeCards.length, 2)
  assert.equal('lastFullRaiseSize' in safe.currentHand!, false)
  assert.equal('actedThisRound' in safe.currentHand!, false)
  assert.equal('deck' in safe.currentHand!, false)
  assert.equal('burnCards' in safe.currentHand!, false)
})

test('safe snapshot hides every other player hole card', () => {
  const state = running(seated(table(), 3))
  const viewer = state.players[0]!.playerId
  const safe = toPlayerSafeTableState(state, viewer)
  assert.equal(safe.currentHand!.players.filter(player => player.playerId !== viewer).every(player => player.holeCards.length === 0), true)
})

test('spectator or unknown viewer receives no private hole cards', () => {
  const state = running()
  for (const viewer of [undefined, 'spectator', '']) {
    const safe = toPlayerSafeTableState(state, viewer)
    assert.equal(safe.currentHand!.players.every(player => player.holeCards.length === 0), true)
  }
})

test('safe snapshot includes seats, stacks, board, pot, actor, and status', () => {
  const state = running()
  const safe = toPlayerSafeTableState(state)
  assert.equal(safe.seats.length, 6)
  assert.equal(safe.players.length, 2)
  assert.equal(safe.currentHand!.board.length, 0)
  assert.equal(safe.currentHand!.pot, state.currentHand!.pot)
  assert.equal(safe.currentHand!.currentActor, state.currentHand!.currentActor)
  assert.equal(safe.status, 'IN_HAND')
})

test('safe snapshots are immutable and do not expose internal objects', () => {
  const safe = toPlayerSafeTableState(running(), 'player-1')
  assert.equal(Object.isFrozen(safe), true)
  assert.equal(Object.isFrozen(safe.seats), true)
  assert.equal(Object.isFrozen(safe.players), true)
  assert.equal(Object.isFrozen(safe.currentHand), true)
})

test('action without an active hand is rejected', () => {
  const state = seated(table(), 2)
  assert.throws(() => applyTableAction(state, { playerId: 'player-1', type: 'check' }), /no active hand/)
})

test('expected version can be supplied separately from the action payload', () => {
  const state = running()
  const actor = state.currentHand!.players.find(player => player.seat === state.currentHand!.currentActor)!
  const next = applyTableAction(state, { playerId: actor.playerId, type: 'call' }, state.stateVersion)
  assert.equal(next.stateVersion, state.stateVersion + 1)
})

test('invalid table and player metadata are rejected', () => {
  assert.throws(() => createPokerTable({ tableId: '', smallBlind: 5, bigBlind: 10 }), /Table id/)
  assert.throws(() => seatPlayer(table(), { playerId: 'a', seat: 1, stack: -1 }), /non-negative/)
  assert.throws(() => seatPlayer(table(), { playerId: 'a', seat: 1, stack: 1, ready: 'yes' as unknown as boolean }), /Ready must be boolean/)
})
