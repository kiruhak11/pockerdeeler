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
    lastActedAtBet: Object.freeze([]),
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
  assert.equal(next.players.find(player => player.playerId === 'player-1')?.lastAction, 'check')
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
  assert.equal(player.lastAction, 'call')
})

test('bet, raise, fold and all-in expose only the last server action', () => {
  const bet = action(postflopLike(), 'player-1', 'bet', 20)
  assert.equal(bet.players.find(player => player.playerId === 'player-1')?.lastAction, 'bet')
  let raised = action(start(), 'player-1', 'raise', 20)
  assert.equal(raised.players.find(player => player.playerId === 'player-1')?.lastAction, 'raise')
  const folded = action(start(2), 'player-1', 'fold')
  assert.equal(folded.players.find(player => player.playerId === 'player-1')?.lastAction, 'fold')
  const allIn = action(postflopLike(), 'player-1', 'all-in')
  assert.equal(allIn.players.find(player => player.playerId === 'player-1')?.lastAction, 'all-in')
  raised = action(raised, 'player-2', 'call')
  assert.equal(raised.players.find(player => player.playerId === 'player-1')?.lastAction, 'raise')
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

test('short all-in raise is accepted without changing the full raise size', () => {
  const input = players(3)
  input[1] = { ...input[1]!, stack: 25 }
  const raised = action(startWith(input), 'player-1', 'raise', 20)
  const next = action(raised, 'player-2', 'all-in')
  const player = next.players.find(item => item.playerId === 'player-2')!
  assert.equal(next.currentBet, 25)
  assert.equal(next.lastFullRaiseSize, 10)
  assert.equal(player.streetContribution, 25)
  assert.equal(player.stack, 0)
  assert.equal(player.status, 'ALL_IN')
  assert.equal(next.pot, 55)
  assert.equal(next.currentActor, 3)
})

function afterShortAllIn(playerThreeStack = 100): InternalHandState {
  const input = players(3)
  input[1] = { ...input[1]!, stack: 25 }
  input[2] = { ...input[2]!, stack: playerThreeStack }
  let state = action(startWith(input), 'player-1', 'raise', 20)
  state = action(state, 'player-2', 'all-in')
  return state
}

test('one short all-in does not reopen raise for an earlier actor', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  assert.equal(state.currentActor, 1)
  assert.throws(() => action(state, 'player-1', 'raise', 35), /not reopened/)
})

test('a short all-in does not reduce the minimum raise target', () => {
  const state = afterShortAllIn()
  assert.equal(state.currentBet, 25)
  assert.equal(state.lastFullRaiseSize, 10)
  assert.equal(getMinimumRaiseTo(state), 35)
})

test('a closed player cannot use a full raise action to bypass reopening', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  assert.throws(() => action(state, 'player-1', 'raise', 45), /not reopened/)
})

test('a closed player may use all-in only as an all-in call', () => {
  const input = players(3)
  input[0] = { ...input[0]!, stack: 25 }
  input[1] = { ...input[1]!, stack: 25 }
  let state = action(startWith(input), 'player-1', 'raise', 20)
  state = action(state, 'player-2', 'all-in')
  state = action(state, 'player-3', 'call')
  state = action(state, 'player-1', 'all-in')
  assert.equal(state.players.find(player => player.playerId === 'player-1')!.status, 'ALL_IN')
  assert.equal(state.currentBet, 25)
})

test('short all-in cannot be submitted as an ordinary under-minimum raise', () => {
  const state = afterShortAllIn()
  assert.throws(() => action(state, 'player-3', 'raise', 30), /at least 10/)
})

test('short all-in bet after a check preserves earlier action history', () => {
  let state = postflopLike()
  state = action(state, 'player-1', 'check')
  state = Object.freeze({
    ...state,
    players: Object.freeze(state.players.map(player => player.playerId === 'player-2'
      ? Object.freeze({ ...player, stack: 5, status: 'ACTIVE' as const })
      : player)),
    currentActor: 2
  })
  state = action(state, 'player-2', 'all-in')
  assert.deepEqual(state.actedThisRound, ['player-1', 'player-2'])
  assert.equal(state.currentBet, 5)
  assert.equal(state.lastFullRaiseSize, 10)
  assert.equal(state.currentActor, 3)
})

test('a short all-in leaves the round open for the next actionable player', () => {
  const state = afterShortAllIn()
  assert.equal(state.bettingRoundComplete, false)
  assert.equal(state.currentActor, 3)
})

test('short all-in records the action level used for reopening decisions', () => {
  const state = afterShortAllIn()
  assert.deepEqual(state.lastActedAtBet, [
    { playerId: 'player-1', bet: 20 },
    { playerId: 'player-2', bet: 25 }
  ])
})

test('short all-in keeps the all-in player stack at zero and contributions balanced', () => {
  const state = afterShortAllIn()
  const player = state.players.find(item => item.playerId === 'player-2')!
  assert.equal(player.stack, 0)
  assert.equal(player.contribution, 25)
  assert.equal(player.streetContribution, 25)
  assert.ok(state.players.every(item => item.stack >= 0))
})

test('two short all-ins preserve the original full raise size', () => {
  let state = afterShortAllIn(29)
  state = action(state, 'player-3', 'all-in')
  assert.equal(state.currentBet, 29)
  assert.equal(state.lastFullRaiseSize, 10)
  assert.equal(getMinimumRaiseTo(state), 39)
})

test('full raise after cumulative short all-ins uses the current target contribution', () => {
  let state = afterShortAllIn(30)
  state = action(state, 'player-3', 'all-in')
  state = action(state, 'player-1', 'raise', 40)
  const player = state.players.find(item => item.playerId === 'player-1')!
  assert.equal(player.streetContribution, 40)
  assert.equal(player.contribution, 40)
})

test('short all-in player is skipped on every subsequent turn', () => {
  const state = afterShortAllIn()
  assert.equal(state.currentActor, 3)
  assert.throws(() => action(state, 'player-2', 'call'), /not this player\'s turn/)
})

test('an earlier actor may call after a short all-in closes raising', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  state = action(state, 'player-1', 'call')
  assert.equal(state.players.find(player => player.playerId === 'player-1')!.streetContribution, 25)
  assert.equal(state.bettingRoundComplete, true)
})

test('an earlier actor may fold after a short all-in closes raising', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  state = action(state, 'player-1', 'fold')
  assert.equal(state.players.find(player => player.playerId === 'player-1')!.status, 'FOLDED')
  assert.equal(state.bettingRoundComplete, true)
})

test('an unacted player may make a full raise after a short all-in', () => {
  const state = afterShortAllIn()
  assert.equal(state.currentActor, 3)
  assert.equal(getMinimumRaiseTo(state), 35)
  const next = action(state, 'player-3', 'raise', 35)
  assert.equal(next.currentBet, 35)
  assert.equal(next.lastFullRaiseSize, 10)
})

test('cumulative short all-ins below the threshold do not reopen raising', () => {
  let state = afterShortAllIn(29)
  state = action(state, 'player-3', 'all-in')
  assert.equal(state.currentBet, 29)
  assert.equal(state.currentBet - 20, 9)
  assert.throws(() => action(state, 'player-1', 'raise', 39), /not reopened/)
})

test('cumulative short all-ins at the exact threshold reopen raising', () => {
  let state = afterShortAllIn(30)
  state = action(state, 'player-3', 'all-in')
  assert.equal(state.currentBet - 20, 10)
  const next = action(state, 'player-1', 'raise', 40)
  assert.equal(next.currentBet, 40)
})

test('cumulative short all-ins above the threshold reopen raising', () => {
  let state = afterShortAllIn(31)
  state = action(state, 'player-3', 'all-in')
  assert.equal(state.currentBet - 20, 11)
  const next = action(state, 'player-1', 'raise', 41)
  assert.equal(next.currentBet, 41)
})

test('a reopened player can make a full raise after cumulative short all-ins', () => {
  let state = afterShortAllIn(30)
  state = action(state, 'player-3', 'all-in')
  state = action(state, 'player-1', 'raise', 45)
  assert.equal(state.currentBet, 45)
  assert.equal(state.lastFullRaiseSize, 15)
})

test('a full raise after a short all-in reopens the normal action sequence', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'raise', 35)
  assert.equal(state.currentActor, 1)
  state = action(state, 'player-1', 'raise', 45)
  assert.equal(state.currentBet, 45)
  assert.equal(state.lastFullRaiseSize, 10)
})

test('a larger full raise after a short all-in updates lastFullRaiseSize', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'raise', 35)
  state = action(state, 'player-1', 'raise', 50)
  assert.equal(state.currentBet, 50)
  assert.equal(state.lastFullRaiseSize, 15)
  assert.equal(getMinimumRaiseTo(state), 65)
})

test('all-in cannot bypass a closed raise right', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  assert.throws(() => action(state, 'player-1', 'all-in'), /not reopened/)
})

test('short all-in followed by calls completes the betting round', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  state = action(state, 'player-1', 'call')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
})

test('short all-in followed by a fold completes the betting round', () => {
  let state = afterShortAllIn()
  state = action(state, 'player-3', 'call')
  state = action(state, 'player-1', 'fold')
  assert.equal(state.bettingRoundComplete, true)
  assert.equal(state.currentActor, null)
})

test('multiple short all-ins accumulate and update the pot once each', () => {
  let state = afterShortAllIn(29)
  assert.equal(state.pot, 55)
  state = action(state, 'player-3', 'all-in')
  assert.equal(state.currentBet, 29)
  assert.equal(state.pot, 74)
  state = action(state, 'player-1', 'call')
  assert.equal(state.pot, 83)
  assert.equal(state.bettingRoundComplete, true)
})

test('heads-up short all-in does not reopen an insufficient raise', () => {
  const input = players(2)
  input[1] = { ...input[1]!, stack: 25 }
  let state = action(startWith(input), 'player-1', 'raise', 20)
  state = action(state, 'player-2', 'all-in')
  assert.equal(state.currentActor, 1)
  assert.throws(() => action(state, 'player-1', 'raise', 35), /not reopened/)
  state = action(state, 'player-1', 'call')
  assert.equal(state.bettingRoundComplete, true)
})

test('heads-up exact cumulative threshold reopens raising', () => {
  const input = players(2)
  input[1] = { ...input[1]!, stack: 30 }
  let state = action(startWith(input), 'player-1', 'raise', 20)
  state = action(state, 'player-2', 'all-in')
  assert.equal(state.currentBet - 20, 10)
  state = action(state, 'player-1', 'raise', 40)
  assert.equal(state.currentBet, 40)
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
