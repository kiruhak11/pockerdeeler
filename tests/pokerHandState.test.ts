import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, type Card } from '../server/utils/pokerDeck'
import { nextDealerSeat, startHand, toPlayerSafeHandState, type HandStartPlayer } from '../server/utils/pokerHandState'

const players = (count: number, stacks = 100): HandStartPlayer[] => Array.from({ length: count }, (_, index) => ({
  playerId: `player-${index + 1}`,
  seat: index + 1,
  stack: stacks
}))

const deterministicCards: Card[] = [
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

const handWith = (count: number, options: Partial<Parameters<typeof startHand>[0]> = {}) => startHand({
  players: players(count),
  smallBlind: 5,
  bigBlind: 10,
  deck: createPredefinedDeck(deterministicCards),
  ...options
})

test('starts a heads-up hand with a unique id and preflop state', () => {
  const first = handWith(2)
  const second = handWith(2)
  assert.notEqual(first.handId, second.handId)
  assert.equal(first.street, 'PREFLOP')
  assert.deepEqual(first.board, [])
  assert.equal(first.players.length, 2)
})

test('starts a six-player hand', () => {
  const state = handWith(6)
  assert.equal(state.players.length, 6)
  assert.equal(state.pot, 15)
})

test('rejects fewer than two players', () => {
  assert.throws(() => handWith(1), /at least 2 players/)
})

test('rejects more than six players', () => {
  assert.throws(() => handWith(7), /at most 6 players/)
})

test('rejects duplicate seats', () => {
  const input = players(2)
  input[1] = { ...input[1]!, seat: input[0]!.seat }
  assert.throws(() => startHand({ players: input, smallBlind: 5, bigBlind: 10 }), /Seats must be unique/)
})

test('rejects duplicate player ids', () => {
  const input = players(2)
  input[1] = { ...input[1]!, playerId: input[0]!.playerId }
  assert.throws(() => startHand({ players: input, smallBlind: 5, bigBlind: 10 }), /Player ids must be unique/)
})

test('rejects invalid stacks', () => {
  assert.throws(() => startHand({ players: [{ playerId: 'a', seat: 1, stack: 0 }, { playerId: 'b', seat: 2, stack: 10 }], smallBlind: 5, bigBlind: 10 }), /Stack must be a positive integer/)
  assert.throws(() => startHand({ players: [{ playerId: 'a', seat: 1, stack: 1.5 }, { playerId: 'b', seat: 2, stack: 10 }], smallBlind: 5, bigBlind: 10 }), /Stack must be a positive integer/)
})

test('rejects invalid blinds', () => {
  assert.throws(() => handWith(2, { smallBlind: 0 }), /Small blind must be a positive integer/)
  assert.throws(() => handWith(2, { bigBlind: 0 }), /Big blind must be a positive integer/)
  assert.throws(() => handWith(2, { smallBlind: 10, bigBlind: 5 }), /Big blind must be greater/)
})

test('selects the first dealer and rotates clockwise', () => {
  assert.equal(nextDealerSeat([{ seat: 2 }, { seat: 5 }, { seat: 9 }]), 2)
  assert.equal(nextDealerSeat([{ seat: 2 }, { seat: 5 }, { seat: 9 }], 2), 5)
  assert.equal(nextDealerSeat([{ seat: 2 }, { seat: 5 }, { seat: 9 }], 5), 9)
})

test('dealer rotation wraps around and skips omitted seats', () => {
  assert.equal(nextDealerSeat([{ seat: 2 }, { seat: 5 }, { seat: 9 }], 9), 2)
  assert.equal(nextDealerSeat([{ seat: 2 }, { seat: 9 }], 5), 9)
})

test('three or more players assign blinds clockwise after dealer', () => {
  const state = handWith(4, { previousDealerSeat: 1 })
  assert.equal(state.dealerSeat, 2)
  assert.equal(state.smallBlindSeat, 3)
  assert.equal(state.bigBlindSeat, 4)
})

test('heads-up assigns dealer as small blind and the other player as big blind', () => {
  const state = handWith(2)
  assert.equal(state.dealerSeat, 1)
  assert.equal(state.smallBlindSeat, 1)
  assert.equal(state.bigBlindSeat, 2)
})

test('heads-up dealer and small blind acts first preflop', () => {
  const state = handWith(2)
  assert.equal(state.currentActor, state.dealerSeat)
})

test('three or more players start preflop action left of the big blind', () => {
  const state = handWith(4)
  assert.equal(state.currentActor, 4)
  assert.equal(state.bigBlindSeat, 3)
})

test('each player receives exactly two cards in round-robin order', () => {
  const state = handWith(3)
  assert.deepEqual(state.players.map(player => player.holeCards), [
    [deterministicCards[2], deterministicCards[5]],
    [deterministicCards[0], deterministicCards[3]],
    [deterministicCards[1], deterministicCards[4]]
  ])
})

test('all hole cards are unique and remain removed from the deck', () => {
  const state = handWith(6)
  const dealt = state.players.flatMap(player => player.holeCards)
  const keys = dealt.map(card => `${card.rank}:${card.suit}`)
  assert.equal(new Set(keys).size, 12)
  assert.equal(state.deck.remainingCount, deterministicCards.length - 12)
  assert.equal(state.deck.availableCards.some(card => keys.includes(`${card.rank}:${card.suit}`)), false)
})

test('deterministic deck gives expected cards by seat', () => {
  const state = handWith(2)
  assert.deepEqual(state.players[0]!.holeCards, [deterministicCards[0], deterministicCards[2]])
  assert.deepEqual(state.players[1]!.holeCards, [deterministicCards[1], deterministicCards[3]])
})

test('rejects a deck that cannot deal two cards to every player', () => {
  assert.throws(() => startHand({
    players: players(3),
    smallBlind: 5,
    bigBlind: 10,
    deck: createPredefinedDeck(deterministicCards.slice(0, 5))
  }), /not contain enough cards/)
})

test('blinds reduce stacks and contributions by actual posted amounts', () => {
  const state = handWith(3)
  const smallBlind = state.players.find(player => player.seat === state.smallBlindSeat)!
  const bigBlind = state.players.find(player => player.seat === state.bigBlindSeat)!
  assert.equal(smallBlind.stack, 95)
  assert.equal(smallBlind.contribution, 5)
  assert.equal(smallBlind.streetContribution, 5)
  assert.equal(bigBlind.stack, 90)
  assert.equal(bigBlind.contribution, 10)
  assert.equal(bigBlind.streetContribution, 10)
  assert.equal(state.pot, 15)
})

test('short small blind posts all remaining chips and becomes all-in', () => {
  const input = players(3)
  input[1] = { ...input[1]!, stack: 3 }
  const state = startHand({ players: input, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deterministicCards) })
  const smallBlind = state.players.find(player => player.seat === state.smallBlindSeat)!
  assert.equal(smallBlind.stack, 0)
  assert.equal(smallBlind.contribution, 3)
  assert.equal(smallBlind.status, 'ALL_IN')
  assert.equal(state.pot, 13)
})

test('short big blind posts all remaining chips and becomes all-in', () => {
  const input = players(3)
  input[2] = { ...input[2]!, stack: 7 }
  const state = startHand({ players: input, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deterministicCards) })
  const bigBlind = state.players.find(player => player.seat === state.bigBlindSeat)!
  assert.equal(bigBlind.stack, 0)
  assert.equal(bigBlind.contribution, 7)
  assert.equal(bigBlind.status, 'ALL_IN')
  assert.equal(state.pot, 12)
})

test('all-in blind players are skipped when selecting current actor', () => {
  const input = players(3)
  input[2] = { ...input[2]!, stack: 7 }
  const state = startHand({ players: input, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deterministicCards) })
  assert.equal(state.bigBlindSeat, 3)
  assert.equal(state.currentActor, 1)
})

test('current actor is null when every player is all-in after blinds', () => {
  const input = players(2, 5)
  const state = startHand({ players: input, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(deterministicCards) })
  assert.equal(state.currentActor, null)
  assert.equal(state.pot, 10)
})

test('player-safe state hides opponents and internal deck', () => {
  const state = handWith(2)
  const safe = toPlayerSafeHandState(state, 'player-1')
  assert.deepEqual(safe.players[0]!.holeCards, state.players[0]!.holeCards)
  assert.deepEqual(safe.players[1]!.holeCards, [])
  assert.equal('deck' in safe, false)
})

test('hand id remains unique across starts', () => {
  const ids = new Set(Array.from({ length: 10 }, () => handWith(2).handId))
  assert.equal(ids.size, 10)
})
