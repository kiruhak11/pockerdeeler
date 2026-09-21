import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, createShuffledDeck, createStandardDeck, RANKS, SUITS, type Card } from '../server/utils/pokerDeck'

const key = (card: Card) => `${card.rank}:${card.suit}`

test('standard deck contains 52 unique cards', () => {
  const deck = createStandardDeck()
  const cards = deck.availableCards
  assert.equal(deck.size, 52)
  assert.equal(cards.length, 52)
  assert.equal(new Set(cards.map(key)).size, 52)
})

test('standard deck contains every suit and rank combination', () => {
  const cards = createStandardDeck().availableCards
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      assert.ok(cards.some(card => card.suit === suit && card.rank === rank))
    }
  }
})

test('dealt cards leave the available deck and cannot be dealt twice', () => {
  const deck = createStandardDeck()
  const first = deck.deal()
  assert.equal(deck.remainingCount, 51)
  assert.equal(deck.hasAvailable(first), false)
  assert.equal(deck.availableCards.some(card => key(card) === key(first)), false)
  const dealt = deck.dealMany(51)
  assert.equal(dealt.length, 51)
  assert.equal(deck.remainingCount, 0)
  assert.throws(() => deck.deal(), /empty deck/)
})

test('empty deck fails clearly when a card is requested', () => {
  const deck = createPredefinedDeck([])
  assert.equal(deck.remainingCount, 0)
  assert.throws(() => deck.deal(), /empty deck/)
})

test('production shuffle changes order without changing composition', () => {
  const standard = createStandardDeck().availableCards.map(key)
  const shuffled = createShuffledDeck().availableCards.map(key)
  assert.equal(shuffled.length, 52)
  assert.deepEqual([...shuffled].sort(), [...standard].sort())
  const changed = shuffled.some((card, index) => card !== standard[index])
  assert.equal(changed, true)
})

test('predefined deck deals cards in exactly the supplied order', () => {
  const cards: Card[] = [
    { suit: 'spades', rank: 'A' },
    { suit: 'hearts', rank: 'K' },
    { suit: 'clubs', rank: '2' }
  ]
  const deck = createPredefinedDeck(cards)
  assert.deepEqual(deck.dealMany(cards.length), cards)
})

test('identical predefined decks reproduce the same deal', () => {
  const cards: Card[] = [
    { suit: 'diamonds', rank: '7' },
    { suit: 'clubs', rank: 'Q' },
    { suit: 'hearts', rank: '3' },
    { suit: 'spades', rank: 'J' }
  ]
  const first = createPredefinedDeck(cards).dealMany(cards.length)
  const second = createPredefinedDeck(cards).dealMany(cards.length)
  assert.deepEqual(first, second)
})

test('duplicate cards are rejected when constructing a deck', () => {
  const card: Card = { suit: 'clubs', rank: 'A' }
  assert.throws(() => createPredefinedDeck([card, card]), /Duplicate card/)
})

test('dealMany rejects requests larger than the remaining deck', () => {
  const deck = createPredefinedDeck([{ suit: 'clubs', rank: 'A' }])
  assert.throws(() => deck.dealMany(2), /more cards than remain/)
  assert.equal(deck.remainingCount, 1)
})
