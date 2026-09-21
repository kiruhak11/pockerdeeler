import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, createStandardDeck, type Card, type Rank, type Suit } from '../server/utils/pokerDeck'
import { advanceStreet, startHand, type HandStartPlayer, type InternalHandState } from '../server/utils/pokerHandState'
import { prepareNextHand, type NextHandPlayer } from '../server/utils/pokerNextHand'

const ranks: Record<string, Rank> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7',
  '8': '8', '9': '9', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A'
}
const suits: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

function cards(notation: string): Card[] {
  return notation.split(/\s+/).filter(Boolean).map(token => ({
    rank: ranks[token.slice(0, -1)]!,
    suit: suits[token.slice(-1)]!
  }))
}

function deck() {
  return createPredefinedDeck(createStandardDeck().availableCards)
}

function players(count: number, stack = 100): NextHandPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    seat: index + 1,
    stack
  }))
}

function started(result: ReturnType<typeof prepareNextHand>): InternalHandState {
  assert.equal(result.status, 'STARTED')
  return result.hand
}

function totalCards(hand: InternalHandState): Card[] {
  return [
    ...hand.players.flatMap(player => player.holeCards),
    ...hand.deck.availableCards
  ]
}

test('six active players move the dealer one eligible seat clockwise', () => {
  const hand = started(prepareNextHand({ players: players(6), previousDealerSeat: 2, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 3)
})

test('zero-stack and inactive players are skipped during button rotation', () => {
  const input = [
    { playerId: 'a', seat: 1, stack: 100 },
    { playerId: 'b', seat: 2, stack: 100 },
    { playerId: 'zero', seat: 3, stack: 0 },
    { playerId: 'away', seat: 4, stack: 100, active: false },
    { playerId: 'c', seat: 5, stack: 100 }
  ]
  const hand = started(prepareNextHand({ players: input, previousDealerSeat: 2, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 5)
  assert.deepEqual(hand.players.map(player => player.playerId), ['a', 'b', 'c'])
})

test('sitting-out players are skipped while active players remain table participants', () => {
  const input = [
    { playerId: 'a', seat: 2, stack: 100 },
    { playerId: 'away', seat: 5, stack: 100, sittingOut: true },
    { playerId: 'b', seat: 9, stack: 100 },
    { playerId: 'c', seat: 12, stack: 100 }
  ]
  const hand = started(prepareNextHand({ players: input, previousDealerSeat: 2, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 9)
  assert.equal(hand.players.some(player => player.playerId === 'away'), false)
})

test('seat gaps and wrap-around use seat order rather than join order', () => {
  const input = [
    { playerId: 'two', seat: 2, stack: 100 },
    { playerId: 'five', seat: 5, stack: 100 },
    { playerId: 'nine', seat: 9, stack: 100 }
  ]
  assert.equal(started(prepareNextHand({ players: input, previousDealerSeat: 5, smallBlind: 5, bigBlind: 10, deck: deck() })).dealerSeat, 9)
  assert.equal(started(prepareNextHand({ players: input, previousDealerSeat: 9, smallBlind: 5, bigBlind: 10, deck: deck() })).dealerSeat, 2)
})

test('three-player blinds use the seats after the rotated dealer', () => {
  const hand = started(prepareNextHand({ players: players(3), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 2)
  assert.equal(hand.smallBlindSeat, 3)
  assert.equal(hand.bigBlindSeat, 1)
})

test('six-player blinds use the next two eligible seats', () => {
  const hand = started(prepareNextHand({ players: players(6), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 2)
  assert.equal(hand.smallBlindSeat, 3)
  assert.equal(hand.bigBlindSeat, 4)
})

test('heads-up rotates dealer and makes it the small blind and first preflop actor', () => {
  const hand = started(prepareNextHand({ players: players(2), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.dealerSeat, 2)
  assert.equal(hand.smallBlindSeat, 2)
  assert.equal(hand.bigBlindSeat, 1)
  assert.equal(hand.currentActor, 2)
})

test('heads-up postflop action starts with the big blind', () => {
  const hand = started(prepareNextHand({ players: players(2), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  const flop = advanceStreet(Object.freeze({ ...hand, bettingRoundComplete: true, currentActor: null }))
  assert.equal(flop.street, 'FLOP')
  assert.equal(flop.currentActor, hand.bigBlindSeat)
})

test('zero-stack players are excluded from the next hand', () => {
  const input = [
    { playerId: 'a', seat: 1, stack: 100 },
    { playerId: 'b', seat: 2, stack: 0 },
    { playerId: 'c', seat: 3, stack: 100 }
  ]
  const result = prepareNextHand({ players: input, previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() })
  const hand = started(result)
  assert.deepEqual(hand.players.map(player => player.playerId), ['a', 'c'])
  assert.equal(hand.players.some(player => player.playerId === 'b'), false)
})

test('one or zero eligible players returns waiting without creating a hand', () => {
  const one = prepareNextHand({ players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 0 }], previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 })
  const zero = prepareNextHand({ players: [{ playerId: 'a', seat: 1, stack: 0, active: false }], previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 })
  assert.deepEqual(one, { status: 'WAITING', reason: 'NOT_ENOUGH_PLAYERS', hand: null, eligiblePlayers: [{ playerId: 'a', seat: 1, stack: 100 }] })
  assert.deepEqual(zero, { status: 'WAITING', reason: 'NOT_ENOUGH_PLAYERS', hand: null, eligiblePlayers: [] })
})

test('short stacks post partial blinds without going negative', () => {
  const hand = started(prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 3 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: 2,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  }))
  const short = hand.players.find(player => player.playerId === 'a')!
  assert.equal(short.stack, 0)
  assert.equal(short.contribution, 3)
  assert.equal(short.status, 'ALL_IN')
  assert.equal(hand.players.every(player => player.stack >= 0), true)
})

test('new hand carries final stacks but resets board, burns, contributions, and statuses', () => {
  const previous = startHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: 2,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  })
  const beforeDealt = previous.deck.dealtCount
  const result = prepareNextHand({
    players: [
      { playerId: 'a', seat: 1, stack: 210, active: true },
      { playerId: 'b', seat: 2, stack: 190, sittingOut: false }
    ],
    previousDealerSeat: previous.dealerSeat,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  })
  const next = started(result)
  assert.equal(next.board.length, 0)
  assert.equal(next.burnCards.length, 0)
  assert.deepEqual(next.players.map(player => player.contribution), [10, 5])
  assert.equal(next.players.every(player => player.status === 'ACTIVE'), true)
  assert.deepEqual(next.players.map(player => player.stack + player.contribution), [210, 190])
  assert.equal(previous.board.length, 0)
  assert.equal(previous.burnCards.length, 0)
  assert.equal(previous.deck.dealtCount, beforeDealt)
})

test('a fresh deck has all 52 unique cards across dealt and remaining cards', () => {
  const hand = started(prepareNextHand({ players: players(2), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  const allCards = totalCards(hand)
  assert.equal(allCards.length, 52)
  assert.equal(new Set(allCards.map(card => `${card.rank}:${card.suit}`)).size, 52)
})

test('previous hand final stacks conserve chips across the hand boundary', () => {
  const input = players(4, 250)
  const total = input.reduce((sum, player) => sum + player.stack, 0)
  const hand = started(prepareNextHand({ players: input, previousDealerSeat: 4, smallBlind: 5, bigBlind: 10, deck: deck() }))
  const nextTotal = hand.pot + hand.players.reduce((sum, player) => sum + player.stack, 0)
  assert.equal(nextTotal, total)
})

test('invalid duplicate player ids, seats, and negative stacks are rejected', () => {
  assert.throws(() => prepareNextHand({ players: [{ playerId: 'a', seat: 1, stack: 10 }, { playerId: 'a', seat: 2, stack: 10 }], previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 }), /Player ids must be unique/)
  assert.throws(() => prepareNextHand({ players: [{ playerId: 'a', seat: 1, stack: 10 }, { playerId: 'b', seat: 1, stack: 10 }], previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 }), /Seats must be unique/)
  assert.throws(() => prepareNextHand({ players: [{ playerId: 'a', seat: 1, stack: -1 }, { playerId: 'b', seat: 2, stack: 10 }], previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 }), /non-negative integer/)
})

test('invalid blind configuration and more than six eligible players are rejected', () => {
  assert.throws(() => prepareNextHand({ players: players(2), previousDealerSeat: 1, smallBlind: 0, bigBlind: 10 }), /Small blind must be a positive integer/)
  assert.throws(() => prepareNextHand({ players: players(2), previousDealerSeat: 1, smallBlind: 10, bigBlind: 5 }), /Big blind must be greater/)
  assert.throws(() => prepareNextHand({ players: players(7), previousDealerSeat: 1, smallBlind: 5, bigBlind: 10 }), /at most 6 players/)
})

test('each started hand gets a new hand id', () => {
  const input = players(2)
  const first = started(prepareNextHand({ players: input, previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() }))
  const second = started(prepareNextHand({ players: input, previousDealerSeat: first.dealerSeat, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.notEqual(first.handId, second.handId)
})

test('previous board and burns are never carried into the next hand', () => {
  const previous = startHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  })
  const previousWithFlop = advanceStreet(Object.freeze({ ...previous, bettingRoundComplete: true, currentActor: null }))
  assert.equal(previousWithFlop.board.length, 3)
  assert.equal(previousWithFlop.burnCards.length, 1)
  const next = started(prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: previousWithFlop.dealerSeat,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  }))
  assert.deepEqual(next.board, [])
  assert.deepEqual(next.burnCards, [])
})

test('historical folded and all-in statuses are reset for eligible positive stacks', () => {
  const hand = started(prepareNextHand({
    players: [
      { playerId: 'folded-last-hand', seat: 1, stack: 75, status: 'FOLDED' },
      { playerId: 'all-in-last-hand', seat: 2, stack: 50, status: 'ALL_IN' }
    ],
    previousDealerSeat: 2,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  }))
  assert.equal(hand.players.every(player => player.status === 'ACTIVE'), true)
})

test('previous contributions do not carry over beyond the new blinds', () => {
  const hand = started(prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 75 }, { playerId: 'b', seat: 2, stack: 65 }, { playerId: 'c', seat: 3, stack: 55 }],
    previousDealerSeat: 1,
    smallBlind: 7,
    bigBlind: 14,
    deck: deck()
  }))
  assert.equal(hand.pot, 21)
  assert.equal(hand.players.reduce((sum, player) => sum + player.contribution, 0), 21)
})

test('a predefined deck is dealt in the existing deterministic order', () => {
  const hand = started(prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    deck: createPredefinedDeck(cards('2c 3c 4c 5c'))
  }))
  assert.deepEqual(hand.players.find(player => player.playerId === 'b')!.holeCards, cards('2c 4c'))
  assert.deepEqual(hand.players.find(player => player.playerId === 'a')!.holeCards, cards('3c 5c'))
})

test('waiting for players does not consume a supplied deck', () => {
  const supplied = deck()
  const result = prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }],
    previousDealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    deck: supplied
  })
  assert.equal(result.status, 'WAITING')
  assert.equal(supplied.dealtCount, 0)
  assert.equal(supplied.remainingCount, 52)
})

test('production default creates a fresh deck instead of reusing a previous hand deck', () => {
  const previous = startHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    deck: deck()
  })
  const dealtBefore = previous.deck.dealtCount
  const next = started(prepareNextHand({
    players: [{ playerId: 'a', seat: 1, stack: 100 }, { playerId: 'b', seat: 2, stack: 100 }],
    previousDealerSeat: previous.dealerSeat,
    smallBlind: 5,
    bigBlind: 10
  }))
  assert.equal(previous.deck.dealtCount, dealtBefore)
  assert.equal(next.deck.dealtCount, 4)
  assert.equal(next.deck.remainingCount, 48)
})

test('input player snapshots are not mutated while preparing a hand', () => {
  const input = players(3)
  const snapshot = structuredClone(input)
  prepareNextHand({ players: input, previousDealerSeat: 1, smallBlind: 5, bigBlind: 10, deck: deck() })
  assert.deepEqual(input, snapshot)
})

test('chip conservation excludes zero-stack and inactive table players from the new hand', () => {
  const input = [
    { playerId: 'a', seat: 1, stack: 100 },
    { playerId: 'zero', seat: 2, stack: 0 },
    { playerId: 'away', seat: 3, stack: 100, active: false },
    { playerId: 'b', seat: 4, stack: 200 }
  ]
  const hand = started(prepareNextHand({ players: input, previousDealerSeat: 4, smallBlind: 5, bigBlind: 10, deck: deck() }))
  assert.equal(hand.players.length, 2)
  assert.equal(hand.pot + hand.players.reduce((sum, player) => sum + player.stack, 0), 300)
})
