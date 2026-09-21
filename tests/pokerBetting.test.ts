import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, type Card } from '../server/utils/pokerDeck'
import { applyBettingAction, getMinimumRaiseTo, getToCall } from '../server/utils/pokerBetting'
import { startHand, type HandStartPlayer, type InternalHandState } from '../server/utils/pokerHandState'

const deckCards: Card[] = [
  { suit: 'clubs', rank: '2' },
  { suit: 'diamonds', rank: '3' },
  { suit: 'hearts', rank: '4' },
  { suit: 'spades', rank: '5' },
  { suit: 'clubs', rank: '6' },
  { suit: 'diamonds', rank: '7' },
  { suit: 'hearts', rank: '8' },
  { suit: 'spades', rank: '9' },
  { suit: 'clubs', rank: 'T' },
  { suit: 'diamonds', rank: 'J' },
  { suit: 'hearts', rank: 'Q' },
  { suit: 'spades', rank: 'K' }
]

function players(count: number, stacks = 100): HandStartPlayer[] {
  return Array.from({ length: count }, (_, index) => ({ playerId: `player-${index + 1}`, seat: index + 1, stack: stacks }))
}

function start(count = 3, stacks = 100): InternalHandState {
  return startHand({ players: players(count, stacks), smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deckCards) })
}

function startWith(playersInput: readonly HandStartPlayer[]): InternalHandState {
  return startHand({ players: playersInput, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deckCards) })
}

function postflopLike(state = start()): InternalHandState {
  const normalizedPlayers = Object.freeze(state.players.map(player => Object.freeze({
    ...player,
    streetContribution: 0,
    status: player.stack > 0 ? 'ACTIVE' as const : 'ALL_IN' as const
  })))
  const currentActor = normalizedPlayers.find(player => player.status === 'ACTIVE')?.seat ?? null
  return Object.freeze({
    ...state,
    players: normalizedPlayers,
    currentBet: 0,
    lastFullRaiseSize: state.bigBlind,
    actedThisRound: Object.freeze([]),
    bettingRoundComplete: currentActor === null,
    currentActor
  })
}

function action(state: InternalHandState, playerId: string, type: 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all-in', amount?: number): InternalHandState {
  return applyBettingAction(state, amount === undefined ? { playerId, type } : { playerId, type, amount })
}

test('check is accepted when toCall is zero', () => {
  const state = postflopLike()
  assert.equal(getToCall(state, 'player-1'), 0)
  const next = action(state, 'player-1', 'check')
  assert.equal(next.currentActor, 2)
  assert.deepEqual(next.actedThisRound, ['player-1'])
})

test('check is rejected when toCall is positive', () => {
  assert.throws(() => action(start(), 'player-1', 'check'), /Cannot check/)
})

test('call pays the full amount to the current bet', () => {
  const state = start()
  assert.equal(getToCall(state, 'player-1'), 10)
  const next = action(state, 'player-1', 'call')
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(player.stack, 90)
  assert.equal(player.streetContribution, 10)
  assert.equal(player.contribution, 10)
  assert.equal(next.pot, 25)
  assert.equal(next.currentActor, 2)
})

test('call with nothing to call is rejected', () => {
  assert.throws(() => action(postflopLike(), 'player-1', 'call'), /nothing to call/)
})

test('short stack call becomes all-in without a negative stack', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 5 }
  const next = action(startWith(input), 'player-1', 'call')
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(player.stack, 0)
  assert.equal(player.streetContribution, 5)
  assert.equal(player.status, 'ALL_IN')
  assert.equal(next.pot, 20)
  assert.ok(player.stack >= 0)
})

test('bet is accepted when currentBet is zero', () => {
  const next = action(postflopLike(), 'player-1', 'bet', 20)
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(next.currentBet, 20)
  assert.equal(next.lastFullRaiseSize, 20)
  assert.equal(player.streetContribution, 20)
  assert.equal(next.pot, 35)
  assert.equal(next.currentActor, 2)
})

test('bet below big blind is rejected unless it is the exact all-in', () => {
  assert.throws(() => action(postflopLike(), 'player-1', 'bet', 4), /at least the big blind/)
  const input = players(3)
  input[0] = { ...input[0]!, stack: 5 }
  const next = action(postflopLike(startWith(input)), 'player-1', 'all-in')
  assert.equal(next.currentBet, 5)
  assert.equal(next.players[0]!.status, 'ALL_IN')
})

test('bet is rejected when a current bet already exists', () => {
  assert.throws(() => action(start(), 'player-1', 'bet', 20), /only available when there is no current bet/)
})

test('raise is rejected when there is no current bet', () => {
  assert.throws(() => action(postflopLike(), 'player-1', 'raise', 20), /only available when there is a current bet/)
})

test('bet above the available stack is rejected', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 15 }
  assert.throws(() => action(postflopLike(startWith(input)), 'player-1', 'bet', 16), /exceeds the player stack/)
})

test('raise uses target street contribution and updates the full raise size', () => {
  const state = start()
  assert.equal(getMinimumRaiseTo(state), 20)
  const next = action(state, 'player-1', 'raise', 20)
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(next.currentBet, 20)
  assert.equal(next.lastFullRaiseSize, 10)
  assert.equal(player.streetContribution, 20)
  assert.equal(player.stack, 80)
  assert.deepEqual(next.actedThisRound, ['player-1'])
})

test('raise below the minimum full raise is rejected', () => {
  const raised = action(start(), 'player-1', 'raise', 20)
  assert.throws(() => action(raised, 'player-2', 'raise', 25), /at least 10/)
})

test('raise above available stack is rejected', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 15 }
  assert.throws(() => action(startWith(input), 'player-1', 'raise', 20), /exceeds the player stack/)
})

test('full all-in raise is accepted', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 30 }
  const next = action(startWith(input), 'player-1', 'all-in')
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(next.currentBet, 30)
  assert.equal(next.lastFullRaiseSize, 20)
  assert.equal(player.stack, 0)
  assert.equal(player.status, 'ALL_IN')
})

test('short all-in raise is explicitly deferred', () => {
  const input = players(3)
  input[1] = { ...input[1]!, stack: 25 }
  const raised = action(startWith(input), 'player-1', 'raise', 20)
  assert.throws(() => action(raised, 'player-2', 'all-in'), /Short all-in raises are not supported/)
})

test('fold keeps committed chips and removes the player from future turns', () => {
  const state = start()
  const next = action(state, 'player-1', 'fold')
  const player = next.players.find(item => item.playerId === 'player-1')!
  assert.equal(player.status, 'FOLDED')
  assert.equal(player.stack, 100)
  assert.equal(player.contribution, 0)
  assert.equal(next.pot, state.pot)
  assert.equal(next.currentActor, 2)
})

test('folded players are skipped clockwise', () => {
  let state = start(4)
  state = action(state, 'player-4', 'fold')
  assert.equal(state.currentActor, 1)
  state = action(state, 'player-1', 'fold')
  assert.equal(state.currentActor, 2)
})

test('all-in players are skipped clockwise', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 5 }
  const next = action(startWith(input), 'player-1', 'all-in')
  assert.equal(next.currentActor, 2)
})

test('action from the wrong turn is rejected', () => {
  const state = start()
  assert.throws(() => action(state, 'player-2', 'call'), /not this player\'s turn/)
})

test('unknown player is rejected', () => {
  assert.throws(() => action(start(), 'missing', 'check'), /Unknown player/)
})

test('all checks complete a no-bet street', () => {
  let state = postflopLike()
  state = action(state, 'player-1', 'check')
  state = action(state, 'player-2', 'check')
  state = action(state, 'player-3', 'check')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
})

test('bet followed by calls completes the street', () => {
  let state = postflopLike()
  state = action(state, 'player-1', 'bet', 10)
  state = action(state, 'player-2', 'call')
  state = action(state, 'player-3', 'call')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
  assert.ok(state.players.every(player => player.streetContribution === 10))
})

test('raise followed by calls completes the street', () => {
  let state = start()
  state = action(state, 'player-1', 'raise', 20)
  state = action(state, 'player-2', 'call')
  state = action(state, 'player-3', 'call')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
})

test('folding to one remaining player completes the street without payout', () => {
  const state = action(start(2), 'player-1', 'fold')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
  assert.equal(state.pot, 15)
})

test('multiple all-in calls complete when remaining actors have matched the bet', () => {
  const input = players(4)
  input[3] = { ...input[3]!, stack: 5 }
  let state = startWith(input)
  state = action(state, 'player-4', 'all-in')
  state = action(state, 'player-1', 'call')
  state = action(state, 'player-2', 'call')
  state = action(state, 'player-3', 'check')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
})

test('repeated action cannot break the turn queue', () => {
  const state = action(postflopLike(), 'player-1', 'check')
  assert.equal(state.currentActor, 2)
  assert.throws(() => action(state, 'player-1', 'check'), /not this player\'s turn/)
  assert.equal(state.currentActor, 2)
})

test('completed rounds reject further actions', () => {
  let state = postflopLike()
  state = action(state, 'player-1', 'check')
  state = action(state, 'player-2', 'check')
  state = action(state, 'player-3', 'check')
  assert.throws(() => action(state, 'player-1', 'check'), /Betting round is complete/)
})

test('call and all-in actions never make a stack negative', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 1 }
  const next = action(startWith(input), 'player-1', 'all-in')
  assert.equal(next.players[0]!.stack, 0)
  assert.ok(next.players.every(player => player.stack >= 0))
})

test('an all-in call that exactly matches the bet is marked all-in', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 10 }
  let state = startWith(input)
  state = action(state, 'player-1', 'call')
  const player = state.players[0]!
  assert.equal(player.streetContribution, 10)
  assert.equal(player.stack, 0)
  assert.equal(player.status, 'ALL_IN')
  assert.equal(state.currentActor, 2)
})
