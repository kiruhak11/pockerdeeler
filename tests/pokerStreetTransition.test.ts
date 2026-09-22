import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBettingAction } from '../server/utils/pokerBetting'
import { createPredefinedDeck, createStandardDeck, type Card } from '../server/utils/pokerDeck'
import {
  advanceStreet,
  startHand,
  toPlayerSafeHandState,
  type HandStartPlayer,
  type InternalHandState
} from '../server/utils/pokerHandState'

const streetCards = createStandardDeck().availableCards.slice(0, 20)

function players(count: number, stack = 100): HandStartPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    seat: index + 1,
    stack
  }))
}

function start(count = 3, stack = 100, smallBlind = 5, bigBlind = 10): InternalHandState {
  return startHand({
    players: players(count, stack),
    smallBlind,
    bigBlind,
    deck: createPredefinedDeck(streetCards)
  })
}

function action(state: InternalHandState, playerId: string, type: 'check' | 'call' | 'all-in' | 'fold'): InternalHandState {
  return applyBettingAction(state, { playerId, type })
}

function completePreflop(state: InternalHandState): InternalHandState {
  let next = state
  while (!next.bettingRoundComplete) {
    const actor = next.players.find(player => player.seat === next.currentActor)
    assert.ok(actor)
    next = action(next, actor.playerId, next.currentBet === actor.streetContribution ? 'check' : 'call')
  }
  return next
}

function completeChecks(state: InternalHandState): InternalHandState {
  let next = state
  while (!next.bettingRoundComplete) {
    const actor = next.players.find(player => player.seat === next.currentActor)
    assert.ok(actor)
    next = action(next, actor.playerId, 'check')
  }
  return next
}

function key(card: Card): string {
  return `${card.rank}:${card.suit}`
}

test('cannot advance before the betting round is complete', () => {
  assert.throws(() => advanceStreet(start()), /Betting round must be complete/)
})

test('PREFLOP advances to FLOP with one burn and three board cards', () => {
  const state = advanceStreet(completePreflop(start()))
  assert.equal(state.street, 'FLOP')
  assert.deepEqual(state.burnCards, [streetCards[6]])
  assert.deepEqual(state.board, streetCards.slice(7, 10))
})

test('FLOP advances to TURN with a new burn and one board card', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  assert.equal(turn.street, 'TURN')
  assert.deepEqual(turn.burnCards, [streetCards[6], streetCards[10]])
  assert.deepEqual(turn.board, streetCards.slice(7, 10).concat(streetCards[11]!))
})

test('TURN advances to RIVER with a new burn and one board card', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  assert.equal(river.street, 'RIVER')
  assert.deepEqual(river.burnCards, [streetCards[6], streetCards[10], streetCards[12]])
  assert.deepEqual(river.board, streetCards.slice(7, 10).concat(streetCards[11]!, streetCards[13]!))
})

test('RIVER advances to SHOWDOWN without burning or dealing', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  const remaining = river.deck.remainingCount
  const riverContributions = river.players.map(player => player.streetContribution)
  const showdown = advanceStreet(completeChecks(river))
  assert.equal(showdown.street, 'SHOWDOWN')
  assert.equal(showdown.board.length, 5)
  assert.equal(showdown.burnCards.length, 3)
  assert.equal(showdown.deck.remainingCount, remaining)
  assert.equal(showdown.currentActor, null)
  assert.deepEqual(showdown.players.map(player => player.streetContribution), riverContributions)
})

test('each new betting street resets contributions and action tracking', () => {
  const preflop = completePreflop(start())
  const flop = advanceStreet(preflop)
  assert.equal(flop.currentBet, 0)
  assert.equal(flop.lastFullRaiseSize, flop.bigBlind)
  assert.deepEqual(flop.actedThisRound, [])
  assert.deepEqual(flop.lastActedAtBet, [])
  assert.equal(flop.bettingRoundComplete, false)
  assert.ok(flop.players.every(player => player.streetContribution === 0))
  assert.ok(flop.players.every(player => player.lastAction === null))
  assert.equal(flop.pot, preflop.pot)
  assert.ok(flop.players.every((player, index) => player.contribution === preflop.players[index]!.contribution))
})

test('postflop action starts clockwise left of the dealer', () => {
  const state = advanceStreet(completePreflop(start()))
  assert.equal(state.currentActor, 2)
})

test('folded players are skipped when selecting the next postflop actor', () => {
  const flop = advanceStreet(completePreflop(start()))
  const afterFold = action(flop, 'player-2', 'fold')
  assert.equal(afterFold.currentActor, 3)
})

test('all-in players are skipped when selecting the next postflop actor', () => {
  const flop = advanceStreet(completePreflop(start()))
  const afterAllIn = action(flop, 'player-2', 'all-in')
  assert.equal(afterAllIn.currentActor, 3)
})

test('heads-up postflop action starts with the big blind', () => {
  const preflop = completePreflop(start(2))
  const flop = advanceStreet(preflop)
  assert.equal(flop.currentActor, flop.bigBlindSeat)
  assert.notEqual(flop.currentActor, flop.dealerSeat)
})

test('deterministic deck preserves exact hole, burn, flop, turn, and river order', () => {
  const preflop = completePreflop(start())
  assert.deepEqual(preflop.players.flatMap(player => player.holeCards), [
    streetCards[2], streetCards[5],
    streetCards[0], streetCards[3],
    streetCards[1], streetCards[4]
  ])
  const flop = advanceStreet(preflop)
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  assert.deepEqual(river.burnCards, [streetCards[6], streetCards[10], streetCards[12]])
  assert.deepEqual(river.board, [streetCards[7], streetCards[8], streetCards[9], streetCards[11], streetCards[13]])
})

test('hole cards, board, burn cards, and the remaining deck never duplicate a physical card', () => {
  const state = advanceStreet(completeChecks(advanceStreet(completeChecks(advanceStreet(completePreflop(start()))))))
  const allCards = [
    ...state.players.flatMap(player => player.holeCards),
    ...state.board,
    ...state.burnCards,
    ...state.deck.availableCards
  ].map(key)
  assert.equal(new Set(allCards).size, allCards.length)
})

test('all-in players after PREFLOP run out automatically to SHOWDOWN', () => {
  const state = advanceStreet(start(2, 5))
  assert.equal(state.street, 'SHOWDOWN')
  assert.equal(state.board.length, 5)
  assert.equal(state.burnCards.length, 3)
  assert.equal(state.currentActor, null)
})

test('one active stack against all-in opponents also runs out automatically', () => {
  const input = players(3, 100)
  input[1] = { ...input[1]!, stack: 5 }
  input[2] = { ...input[2]!, stack: 10 }
  let state = startHand({ players: input, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(streetCards) })
  state = action(state, 'player-1', 'call')
  assert.equal(state.bettingRoundComplete, true)
  state = advanceStreet(state)
  assert.equal(state.street, 'SHOWDOWN')
  assert.equal(state.board.length, 5)
})

test('all-in on FLOP automatically deals TURN and RIVER', () => {
  let state = advanceStreet(completePreflop(start(2)))
  state = action(state, 'player-2', 'all-in')
  state = action(state, 'player-1', 'all-in')
  assert.equal(state.bettingRoundComplete, true)
  const showdown = advanceStreet(state)
  assert.equal(showdown.street, 'SHOWDOWN')
  assert.equal(showdown.board.length, 5)
  assert.equal(showdown.burnCards.length, 3)
})

test('all-in on TURN automatically deals RIVER', () => {
  let state = advanceStreet(completePreflop(start(2)))
  state = advanceStreet(completeChecks(state))
  state = action(state, 'player-2', 'all-in')
  state = action(state, 'player-1', 'all-in')
  const showdown = advanceStreet(state)
  assert.equal(showdown.street, 'SHOWDOWN')
  assert.equal(showdown.board.length, 5)
  assert.equal(showdown.burnCards.length, 3)
})

test('automatic runout keeps burn, flop, turn, and river order', () => {
  const showdown = advanceStreet(start(2, 5))
  assert.deepEqual(showdown.burnCards, [streetCards[4], streetCards[8], streetCards[10]])
  assert.deepEqual(showdown.board, [streetCards[5], streetCards[6], streetCards[7], streetCards[9], streetCards[11]])
})

test('a fold leaving one non-folded player finishes without board runout', () => {
  let state = start(3)
  state = action(state, 'player-1', 'fold')
  state = action(state, 'player-2', 'fold')
  assert.equal(state.bettingRoundComplete, true)
  const finished = advanceStreet(state)
  assert.equal(finished.street, 'FINISHED')
  assert.deepEqual(finished.board, [])
  assert.deepEqual(finished.burnCards, [])
  assert.equal(finished.currentActor, null)
})

test('uncontested hand is not sent through SHOWDOWN', () => {
  let state = start(2)
  state = action(state, 'player-1', 'fold')
  assert.equal(state.players.filter(player => player.status !== 'FOLDED').length, 1)
  const finished = advanceStreet(state)
  assert.equal(finished.street, 'FINISHED')
  assert.notEqual(finished.street, 'SHOWDOWN')
})

test('burn cards and internal deck are absent from player-safe state while board is present', () => {
  const state = advanceStreet(completePreflop(start()))
  const safe = toPlayerSafeHandState(state, 'player-1')
  assert.equal('burnCards' in safe, false)
  assert.equal('deck' in safe, false)
  assert.deepEqual(safe.board, state.board)
})

test('transition requires a complete round at every explicit street boundary', () => {
  const flop = advanceStreet(completePreflop(start()))
  assert.throws(() => advanceStreet(flop), /Betting round must be complete/)
})

test('FLOP has exactly one burn card and three board cards', () => {
  const flop = advanceStreet(completePreflop(start()))
  assert.equal(flop.burnCards.length, 1)
  assert.equal(flop.board.length, 3)
})

test('TURN has two burn cards and four board cards', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  assert.equal(turn.burnCards.length, 2)
  assert.equal(turn.board.length, 4)
})

test('RIVER has three burn cards and five board cards', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  assert.equal(river.burnCards.length, 3)
  assert.equal(river.board.length, 5)
})

test('SHOWDOWN has no current actor and keeps the completed board', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  const showdown = advanceStreet(completeChecks(river))
  assert.equal(showdown.currentActor, null)
  assert.equal(showdown.bettingRoundComplete, true)
  assert.equal(showdown.board.length, 5)
})

test('folded status is preserved when a new street begins', () => {
  const flop = advanceStreet(completePreflop(start()))
  const folded = action(flop, 'player-2', 'fold')
  const completed = completeChecks(folded)
  const turn = advanceStreet(completed)
  assert.equal(turn.players.find(player => player.playerId === 'player-2')!.status, 'FOLDED')
})

test('all-in status is preserved when a new street begins', () => {
  const flop = advanceStreet(completePreflop(start(2)))
  const allIn = action(flop, 'player-2', 'all-in')
  const called = action(allIn, 'player-1', 'all-in')
  const showdown = advanceStreet(called)
  assert.equal(showdown.players.every(player => player.status === 'ALL_IN'), true)
})

test('total contributions survive all street resets', () => {
  const preflop = completePreflop(start())
  const flop = advanceStreet(preflop)
  const turn = advanceStreet(completeChecks(flop))
  assert.deepEqual(turn.players.map(player => player.contribution), preflop.players.map(player => player.contribution))
  assert.ok(turn.players.every(player => player.streetContribution === 0))
})

test('the final street transition does not change the deck or burn cards', () => {
  const flop = advanceStreet(completePreflop(start()))
  const turn = advanceStreet(completeChecks(flop))
  const river = advanceStreet(completeChecks(turn))
  const before = river.deck.remainingCount
  const burns = river.burnCards
  const showdown = advanceStreet(completeChecks(river))
  assert.equal(showdown.deck.remainingCount, before)
  assert.deepEqual(showdown.burnCards, burns)
})

test('SHOWDOWN cannot be advanced again', () => {
  const showdown = advanceStreet(start(2, 5))
  assert.throws(() => advanceStreet(showdown), /Cannot advance street from SHOWDOWN/)
})

test('FINISHED uncontested hands cannot be advanced again', () => {
  let state = start(2)
  state = action(state, 'player-1', 'fold')
  const finished = advanceStreet(state)
  assert.throws(() => advanceStreet(finished), /Cannot advance street from FINISHED/)
})

test('insufficient cards fail before an explicit street transition', () => {
  const cards = createStandardDeck().availableCards.slice(0, 6)
  const state = completePreflop(startHand({
    players: players(3),
    smallBlind: 5,
    bigBlind: 10,
    deck: createPredefinedDeck(cards)
  }))
  assert.equal(state.deck.remainingCount, 0)
  assert.throws(() => advanceStreet(state), /does not contain enough cards/)
})

test('postflop actor selection skips a folded seat and starts at the next eligible seat', () => {
  const flop = advanceStreet(completePreflop(start(4)))
  const afterFold = action(flop, 'player-2', 'fold')
  assert.equal(afterFold.currentActor, 3)
})

test('postflop actor selection skips an all-in seat and starts at the next eligible seat', () => {
  const flop = advanceStreet(completePreflop(start(4)))
  const afterAllIn = action(flop, 'player-2', 'all-in')
  assert.equal(afterAllIn.currentActor, 3)
})

test('automatic runout leaves currentActor null on every terminal result', () => {
  const preflopAllIn = advanceStreet(start(2, 5))
  assert.equal(preflopAllIn.currentActor, null)
  const flop = advanceStreet(completePreflop(start(2)))
  const flopAllIn = advanceStreet(action(action(flop, 'player-2', 'all-in'), 'player-1', 'all-in'))
  assert.equal(flopAllIn.currentActor, null)
})

test('player-safe state keeps both board visibility and opponent hole-card secrecy after transition', () => {
  const flop = advanceStreet(completePreflop(start(2)))
  const safe = toPlayerSafeHandState(flop, 'player-1')
  assert.deepEqual(safe.board, flop.board)
  assert.deepEqual(safe.players.find(player => player.playerId === 'player-1')!.holeCards, flop.players[0]!.holeCards)
  assert.deepEqual(safe.players.find(player => player.playerId === 'player-2')!.holeCards, [])
})

test('automatic runout from one active player keeps folded players out of the board flow', () => {
  let state = start(3)
  state = action(state, 'player-1', 'fold')
  state = action(state, 'player-2', 'fold')
  const finished = advanceStreet(state)
  assert.equal(finished.street, 'FINISHED')
  assert.equal(finished.players.filter(player => player.status !== 'FOLDED').length, 1)
  assert.equal(finished.board.length, 0)
})
