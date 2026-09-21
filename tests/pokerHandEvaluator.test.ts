import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareHands, evaluateHand, type HandCategory } from '../server/utils/pokerHandEvaluator'
import type { Card, Rank, Suit } from '../server/utils/pokerDeck'

const RANKS: Record<string, Rank> = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  T: 'T',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A'
}

const SUITS: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

function cards(notation: string): Card[] {
  return notation.split(/\s+/).filter(Boolean).map(token => ({
    rank: RANKS[token.slice(0, -1)]!,
    suit: SUITS[token.slice(-1)]!
  }))
}

function category(notation: string, expected: HandCategory, tieBreak: readonly number[]) {
  const result = evaluateHand(cards(notation))
  assert.equal(result.category, expected)
  assert.deepEqual(result.tieBreak, tieBreak)
  assert.equal(result.bestFive.length, 5)
  return result
}

test('evaluates high card', () => {
  category('As Kd 9c 7h 3s', 'high-card', [14, 13, 9, 7, 3])
})

test('evaluates one pair with kickers', () => {
  category('As Ad Kc 9h 3d', 'one-pair', [14, 13, 9, 3])
})

test('evaluates two pair with kicker', () => {
  category('As Ad Kc Kd 3s', 'two-pair', [14, 13, 3])
})

test('evaluates three of a kind', () => {
  category('As Ad Ac Kd 3s', 'three-of-a-kind', [14, 13, 3])
})

test('evaluates a straight', () => {
  category('9s Td Jc Qh Kd', 'straight', [13])
})

test('evaluates the wheel with ace low', () => {
  category('As 2d 3c 4h 5s', 'straight', [5])
})

test('evaluates the ace-high broadway straight', () => {
  category('As Kd Qc Jh Ts', 'straight', [14])
})

test('evaluates a flush', () => {
  category('As Js 9s 4s 2s', 'flush', [14, 11, 9, 4, 2])
})

test('evaluates a full house', () => {
  category('As Ad Ac Kd Kh', 'full-house', [14, 13])
})

test('evaluates four of a kind with kicker', () => {
  category('As Ad Ac Ah Kd', 'four-of-a-kind', [14, 13])
})

test('evaluates a straight flush', () => {
  category('9s Ts Js Qs Ks', 'straight-flush', [13])
})

test('treats royal flush as ace-high straight flush', () => {
  category('As Ks Qs Js Ts', 'straight-flush', [14])
})

test('selects the best five cards from seven', () => {
  const result = category('As Ad Kc Qd Jc Th 2h', 'straight', [14])
  assert.deepEqual(result.bestFive.map(card => card.rank), ['A', 'K', 'Q', 'J', 'T'])
})

test('a weak pocket pair loses when the board makes a straight', () => {
  category('2s 2h 9c Td Jd Qh Kc', 'straight', [13])
})

test('board plays completely and produces an absolute tie', () => {
  const board = cards('As Kd Qc Jh Ts')
  const left = evaluateHand([...board, ...cards('2c 3d')])
  const right = evaluateHand([...board, ...cards('4c 5d')])
  assert.equal(compareHands(left, right), 0)
})

test('same pair compares the first kicker', () => {
  const left = evaluateHand(cards('As Ad Kc 9h 3d'))
  const right = evaluateHand(cards('Ah Ac Qc 9h 3d'))
  assert.ok(compareHands(left, right) > 0)
})

test('same pair and first kicker compares the second kicker', () => {
  const left = evaluateHand(cards('As Ad Kc 9h 3d'))
  const right = evaluateHand(cards('Ah Ac Qc 9h 2d'))
  assert.ok(compareHands(left, right) > 0)
})

test('same two pair compares the kicker', () => {
  const left = evaluateHand(cards('As Ad Kc Kd Qs'))
  const right = evaluateHand(cards('Ah Ac Qc Qd Js'))
  assert.ok(compareHands(left, right) > 0)
})

test('chooses the higher straight when several are possible', () => {
  category('5c 6d 7h 8s 9c Td Jd', 'straight', [11])
})

test('chooses the five highest cards from six or seven flush cards', () => {
  const result = category('As Ks Qs Js 9s 8s 2d', 'flush', [14, 13, 12, 11, 9])
  assert.deepEqual(result.bestFive.map(card => card.rank), ['A', 'K', 'Q', 'J', '9'])
})

test('uses the higher of two trips as the full house trips', () => {
  category('As Ad Ac Ks Kd Kh 2c', 'full-house', [14, 13])
})

test('uses the two highest pairs when three pairs are available', () => {
  category('As Ad Kc Kd Qh Qs 2c', 'two-pair', [14, 13, 12])
})

test('compares equal quads by their kicker', () => {
  const left = evaluateHand(cards('As Ad Ac Ah Kd'))
  const right = evaluateHand(cards('As Ad Ac Ah Qd'))
  assert.ok(compareHands(left, right) > 0)
})

test('does not use suit as a tiebreaker', () => {
  const left = evaluateHand(cards('As Kc Qd Jh 9s'))
  const right = evaluateHand(cards('Ah Kd Qc Js 9h'))
  assert.equal(compareHands(left, right), 0)
})

test('permuting input cards does not change the result', () => {
  const input = cards('As Ad Kc Qd Jc Th 2h')
  const forward = evaluateHand(input)
  const reversed = evaluateHand([...input].reverse())
  assert.deepEqual(reversed, forward)
})

test('rejects a duplicate physical card', () => {
  assert.throws(() => evaluateHand(cards('As As Kd Qc Jh Ts')), /Duplicate physical card/)
})

test('rejects fewer than five cards', () => {
  assert.throws(() => evaluateHand(cards('As Kd Qc Jh')), /between 5 and 7 cards/)
})

test('rejects more than seven cards', () => {
  assert.throws(() => evaluateHand(cards('As Kd Qc Jh Ts 9d 8c 7h')), /between 5 and 7 cards/)
})

test('straight detection ignores duplicate ranks outside the selected five', () => {
  category('As Ad 2c 3h 4s 5d 9c', 'straight', [5])
})
