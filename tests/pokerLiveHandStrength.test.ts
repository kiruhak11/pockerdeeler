import test from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, createStandardDeck, type Card, type Rank, type Suit } from '../server/utils/pokerDeck'
import { getViewerLiveHandStrength, evaluateLiveHand, pokerCardId } from '../server/utils/pokerLiveHandStrength'
import { createPokerTable, seatPlayer, setPlayerReady, startTableHand, toPlayerSafeTableState } from '../server/utils/pokerTableState'

const ranks: Record<string, Rank> = { '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A' }
const suits: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

function cards(notation: string): Card[] {
  return notation.split(/\s+/).filter(Boolean).map(token => ({ rank: ranks[token.slice(0, -1)]!, suit: suits[token.slice(-1)]! }))
}

function ids(notation: string): string[] {
  return cards(notation).map(pokerCardId)
}

function assertSameCards(actual: readonly string[], expected: string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort())
}

function assertRanks(actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual(actual.map(id => id.split(':', 1)[0]).sort(), [...expected].sort())
}

function strength(hole: string, board = '') {
  return evaluateLiveHand(cards(hole), cards(board))
}

test('preflop different hole cards show high card and only the higher card contributes', () => {
  const result = strength('As Kd')
  assert.equal(result.category, 'high-card')
  assert.equal(result.label, 'Старшая карта')
  assertSameCards(result.contributingCardIds, ids('As'))
})

test('preflop pocket pair highlights both hole cards', () => {
  const result = strength('As Ah')
  assert.equal(result.category, 'one-pair')
  assert.equal(result.label, 'Пара')
  assertSameCards(result.contributingCardIds, ids('As Ah'))
})

test('flop pair highlights the pair structure', () => {
  const result = strength('As Kd', 'Ah 7c 2d')
  assert.equal(result.category, 'one-pair')
  assertSameCards(result.contributingCardIds, ids('As Ah'))
})

test('two pair highlights exactly both pairs', () => {
  const result = strength('As Kd', 'Ah Kc 2d')
  assert.equal(result.category, 'two-pair')
  assertSameCards(result.contributingCardIds, ids('As Ah Kd Kc'))
})

test('three of a kind highlights three cards of the trips rank', () => {
  const result = strength('As Kd', 'Ah Ac 2d')
  assert.equal(result.category, 'three-of-a-kind')
  assertSameCards(result.contributingCardIds, ids('As Ah Ac'))
})

test('straight highlights all five straight cards', () => {
  const result = strength('9s 2d', '5c 6h 7d 8c')
  assert.equal(result.category, 'straight')
  assertSameCards(result.contributingCardIds, ids('5c 6h 7d 8c 9s'))
})

test('wheel straight highlights ace through five', () => {
  const result = strength('As 2d', '3c 4h 5s')
  assert.equal(result.category, 'straight')
  assertSameCards(result.contributingCardIds, ids('As 2d 3c 4h 5s'))
})

test('flush with more than five suited cards uses the evaluator best five', () => {
  const result = strength('As 2s', 'Ks Qs Js 9s 8s')
  assert.equal(result.category, 'flush')
  assertSameCards(result.contributingCardIds, ids('As Ks Qs Js 9s'))
})

test('full house highlights the trips and pair, without a kicker', () => {
  const result = strength('As Kd', 'Ah Ac Kh 2d 3c')
  assert.equal(result.category, 'full-house')
  assertSameCards(result.contributingCardIds, ids('As Ah Ac Kd Kh'))
})

test('two trips choose the higher trips and the lower trips as the pair', () => {
  const result = strength('As Kd', 'Ah Ac Kh Kc 2d')
  assert.equal(result.category, 'full-house')
  assertRanks(result.contributingCardIds, ['A', 'A', 'A', 'K', 'K'])
})

test('quads highlights four cards and not the kicker', () => {
  const result = strength('As Ah', 'Ac Ad Kd')
  assert.equal(result.category, 'four-of-a-kind')
  assertSameCards(result.contributingCardIds, ids('As Ah Ac Ad'))
})

test('straight flush highlights all five cards', () => {
  const result = strength('9s Ts', 'Js Qs Ks')
  assert.equal(result.category, 'straight-flush')
  assertSameCards(result.contributingCardIds, ids('9s Ts Js Qs Ks'))
})

test('board-only straight contributes no hole cards', () => {
  const result = strength('2c 3d', '9s Td Jc Qh Kd')
  assert.equal(result.category, 'straight')
  assertSameCards(result.contributingCardIds, ids('9s Td Jc Qh Kd'))
})

test('board-only straight prefers board cards when a hole card shares a rank', () => {
  const result = strength('9s 2c', '5d 6h 7c 8d 9h')
  assert.equal(result.category, 'straight')
  assertSameCards(result.contributingCardIds, ids('5d 6h 7c 8d 9h'))
})

test('board-only flush contributes no hole cards', () => {
  const result = strength('2c 3d', 'As Ks Qs Js 9s')
  assert.equal(result.category, 'flush')
  assertSameCards(result.contributingCardIds, ids('As Ks Qs Js 9s'))
})

test('board-only full house contributes no hole cards', () => {
  const result = strength('2c 3d', 'As Ah Ac Kd Kh')
  assert.equal(result.category, 'full-house')
  assertSameCards(result.contributingCardIds, ids('As Ah Ac Kd Kh'))
})

test('pair becomes two pair when the turn pairs the second rank', () => {
  assert.equal(strength('As Kd', 'Ah 7c 2d').category, 'one-pair')
  assert.equal(strength('As Kd', 'Ah 7c 2d Kc').category, 'two-pair')
  assertSameCards(strength('As Kd', 'Ah 7c 2d Kc').contributingCardIds, ids('As Ah Kd Kc'))
})

test('pair becomes trips when the turn brings the third rank card', () => {
  assert.equal(strength('As Kd', 'Ah 7c 2d').category, 'one-pair')
  assert.equal(strength('As Kd', 'Ah 7c 2d Ac').category, 'three-of-a-kind')
})

test('two pair becomes full house when the trips rank arrives on the river', () => {
  assert.equal(strength('As Kd', 'Ah 7c 2d Kc').category, 'two-pair')
  const result = strength('As Kd', 'Ah 7c 2d Kc Ad')
  assert.equal(result.category, 'full-house')
  assertSameCards(result.contributingCardIds, ids('As Ah Ad Kd Kc'))
})

test('a later street can replace a straight with a higher straight', () => {
  assertSameCards(strength('9s 2d', '5c 6h 7d 8c').contributingCardIds, ids('5c 6h 7d 8c 9s'))
  assertSameCards(strength('9s 2d', '5c 6h 7d 8c Td').contributingCardIds, ids('6h 7d 8c 9s Td'))
})

test('a river flush replaces the earlier five-card flush selection', () => {
  assertSameCards(strength('As Ks', '2s 5s 9s Qd').contributingCardIds, ids('As Ks 2s 5s 9s'))
  assertSameCards(strength('As Ks', '2s 5s 9s Qd Js').contributingCardIds, ids('As Ks Js 5s 9s'))
})

test('pair kicker is not highlighted', () => {
  const result = strength('As Kd', 'Ah 7c 2d')
  assert.equal(result.contributingCardIds.includes(pokerCardId({ rank: 'K', suit: 'diamonds' })), false)
  assert.equal(result.contributingCardIds.length, 2)
})

test('quads kicker is not highlighted', () => {
  const result = strength('As Ah', 'Ac Ad Kd')
  assert.equal(result.contributingCardIds.includes(pokerCardId({ rank: 'K', suit: 'diamonds' })), false)
  assert.equal(result.contributingCardIds.length, 4)
})

test('category labels are Russian and evaluator category semantics are preserved', () => {
  assert.equal(strength('As Kd', 'Ah 7c 2d').label, 'Пара')
  assert.equal(strength('As Kd', '5c 6h 7d 8s 9c').categoryRank, 4)
})

test('viewer summary is absent for another player', () => {
  const hand = startTableHand(setPlayerReady(seatPlayer(setPlayerReady(seatPlayer(createPokerTable({ tableId: 'live', smallBlind: 5, bigBlind: 10 }), { playerId: 'a', seat: 1, stack: 100 }), 'a', true), { playerId: 'b', seat: 2, stack: 100 }), 'b', true), { deck: createPredefinedDeck(createStandardDeck().availableCards) }).currentHand!
  assert.ok(getViewerLiveHandStrength(hand, 'a'))
  assert.equal(getViewerLiveHandStrength(hand, 'unknown'), null)
})

test('safe table state includes live strength only for the requested viewer', () => {
  let table = createPokerTable({ tableId: 'safe-live', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const running = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const own = toPlayerSafeTableState(running, 'a')
  const opponent = toPlayerSafeTableState(running, 'b')
  assert.ok(own.currentHand?.handStrength)
  assert.equal('handStrength' in opponent.currentHand!, true)
  assert.ok(opponent.currentHand?.handStrength)
  assert.notDeepEqual(own.currentHand?.handStrength, opponent.currentHand?.handStrength)
})

test('safe summary does not contain opponent hole cards', () => {
  let table = createPokerTable({ tableId: 'safe-cards', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const running = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const safe = toPlayerSafeTableState(running, 'a')
  assert.deepEqual(safe.currentHand?.players.find(player => player.playerId === 'b')?.holeCards, [])
  assert.equal(safe.currentHand?.handStrength?.contributingCardIds.some(id => id === pokerCardId(running.currentHand!.players[1]!.holeCards[0]!)), false)
})

test('reconnect receives the same server-derived summary', () => {
  let table = createPokerTable({ tableId: 'reconnect-live', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const running = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  assert.deepEqual(toPlayerSafeTableState(running, 'a').currentHand?.handStrength, toPlayerSafeTableState(running, 'a').currentHand?.handStrength)
})

test('a finished hand has no live summary', () => {
  let table = createPokerTable({ tableId: 'finished-live', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const running = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const finished = { ...running, currentHand: { ...running.currentHand!, street: 'FINISHED' as const } }
  assert.equal(toPlayerSafeTableState(finished, 'a').currentHand?.handStrength, undefined)
})

test('a new preflop hand derives a fresh summary from its own hole cards', () => {
  const first = strength('As Ah')
  const next = strength('Ks Qd')
  assert.equal(first.label, 'Пара')
  assert.equal(next.label, 'Старшая карта')
  assert.notDeepEqual(first.contributingCardIds, next.contributingCardIds)
})

test('contributing card ids are unique and stable', () => {
  const result = strength('As Kd', 'Ah Kc 2d')
  assert.equal(new Set(result.contributingCardIds).size, result.contributingCardIds.length)
  assert.deepEqual(result.contributingCardIds, strength('As Kd', 'Ah Kc 2d').contributingCardIds)
})

test('the live utility does not evaluate fewer than a complete postflop hand', () => {
  assert.throws(() => strength('As Kd', 'Ah 2c'), /five to seven cards/)
})
