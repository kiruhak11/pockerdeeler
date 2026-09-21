import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPots, type PotBuildPlayer } from '../server/utils/pokerPotBuilder'
import { resolveShowdown, type ShowdownPlayer } from '../server/utils/pokerShowdown'
import type { Card, Rank, Suit } from '../server/utils/pokerDeck'

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

function hand(playerId: string, hole: string, status: ShowdownPlayer['status'] = 'ACTIVE'): ShowdownPlayer {
  const holeCards = cards(hole)
  return { playerId, status, holeCards: [holeCards[0]!, holeCards[1]!] as readonly [Card, Card] }
}

function potPlayer(playerId: string, contribution: number, status: ShowdownPlayer['status'] = 'ACTIVE'): PotBuildPlayer {
  return { playerId, contribution, status }
}

function resolve(
  board: string,
  players: readonly { hand: ShowdownPlayer; contribution: number }[]
) {
  const potPlayers: PotBuildPlayer[] = players.map(item => ({
    playerId: item.hand.playerId,
    contribution: item.contribution,
    status: item.hand.status
  }))
  return resolveShowdown(cards(board), players.map(item => item.hand), buildPots(potPlayers))
}

const board = '2c 7d 9h Js Qc'

test('one pot resolves to one winner', () => {
  const result = resolve(board, [
    { hand: hand('a', 'Kd Td'), contribution: 100 },
    { hand: hand('b', 'As Ah'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
  assert.equal(result.pots[0]!.tie, false)
  assert.equal(result.pots[0]!.amount, 200)
})

test('two players with the same hand tie', () => {
  const result = resolve('As Kd Qc Jh Ts', [
    { hand: hand('a', '2c 3d'), contribution: 100 },
    { hand: hand('b', '4c 5d'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a', 'b'])
  assert.equal(result.pots[0]!.tie, true)
})

test('three players can tie when the board plays', () => {
  const result = resolve('As Kd Qc Jh Ts', [
    { hand: hand('a', '2c 3d'), contribution: 50 },
    { hand: hand('b', '4c 5d'), contribution: 50 },
    { hand: hand('c', '6c 7d'), contribution: 50 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a', 'b', 'c'])
})

test('main pot and side pot can have different winners', () => {
  const result = resolve(board, [
    { hand: hand('a', 'Kd Td', 'ALL_IN'), contribution: 100 },
    { hand: hand('b', 'As Ah', 'ALL_IN'), contribution: 300 },
    { hand: hand('c', '8s 6c'), contribution: 500 }
  ])
  assert.deepEqual(result.pots.map(pot => pot.winners), [['a'], ['b']])
  assert.deepEqual(result.pots.map(pot => pot.amount), [300, 400])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'c', amount: 200 }])
})

test('multiple side pots can resolve to different winners', () => {
  const result = resolve(board, [
    { hand: hand('a', 'Kd Td', 'ALL_IN'), contribution: 50 },
    { hand: hand('b', 'As Ah', 'ALL_IN'), contribution: 100 },
    { hand: hand('c', 'Ks Kh', 'ALL_IN'), contribution: 150 },
    { hand: hand('d', '8s 6c'), contribution: 200 }
  ])
  assert.deepEqual(result.pots.map(pot => pot.winners), [['a'], ['b'], ['c']])
  assert.deepEqual(result.pots.map(pot => pot.amount), [200, 150, 100])
})

test('folded player with the best hand is excluded from showdown', () => {
  const result = resolve(board, [
    { hand: hand('folded', 'Kd Td', 'FOLDED'), contribution: 100 },
    { hand: hand('active', 'As Ah'), contribution: 100 },
    { hand: hand('other', '8s 6c'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, ['active', 'other'])
  assert.deepEqual(result.pots[0]!.winners, ['active'])
  assert.equal(result.pots[0]!.winners.includes('folded'), false)
})

test('short all-in can win the main pot but is absent from the side pot', () => {
  const result = resolve(board, [
    { hand: hand('short', 'Kd Td', 'ALL_IN'), contribution: 50 },
    { hand: hand('middle', 'As Ah', 'ALL_IN'), contribution: 100 },
    { hand: hand('deep', '9s 9c'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['short'])
  assert.deepEqual(result.pots[1]!.eligiblePlayerIds, ['middle', 'deep'])
  assert.equal(result.pots[1]!.eligiblePlayerIds.includes('short'), false)
})

test('board plays gives the same evaluation to every eligible player', () => {
  const result = resolve('As Kd Qc Jh Ts', [
    { hand: hand('a', '2c 3d'), contribution: 100 },
    { hand: hand('b', '4c 5d'), contribution: 100 }
  ])
  assert.equal(result.pots[0]!.evaluations[0]!.evaluation.category, 'straight')
  assert.deepEqual(result.pots[0]!.evaluations.map(item => item.evaluation.tieBreak), [[14], [14]])
})

test('kicker resolves an otherwise equal pair', () => {
  const result = resolve('As Ad 7c 2h 9s', [
    { hand: hand('a', 'Kc Qc'), contribution: 100 },
    { hand: hand('b', 'Jc Tc'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
})

test('two-pair kicker is compared by the evaluator', () => {
  const result = resolve('As Kd Kc 2h 9s', [
    { hand: hand('a', 'Ah Qh'), contribution: 100 },
    { hand: hand('b', 'Ad Jh'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
})

test('full-house strength is compared correctly', () => {
  const result = resolve('As Kd Kc 2h 9s', [
    { hand: hand('a', 'Ah Ad'), contribution: 100 },
    { hand: hand('b', '2c 2d'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
})

test('flush strength is compared correctly', () => {
  const result = resolve('2s 5s 9s Kd 3c', [
    { hand: hand('a', 'As Qs'), contribution: 100 },
    { hand: hand('b', 'Js Ts'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
})

test('straight strength is compared correctly', () => {
  const result = resolve('2c 3d 4h 6s Kc', [
    { hand: hand('a', '5s 8d'), contribution: 100 },
    { hand: hand('b', '5h 7d'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['b'])
})

test('quads kicker is compared correctly', () => {
  const result = resolve('As Ad Ac Ah 2c', [
    { hand: hand('a', 'Kd Qd'), contribution: 100 },
    { hand: hand('b', 'Qh Jh'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['a'])
})

test('straight flush strength is compared correctly', () => {
  const result = resolve('4s 5s 6s Kd Qc', [
    { hand: hand('a', '2s 3s'), contribution: 100 },
    { hand: hand('b', '7s 8s'), contribution: 100 }
  ])
  assert.deepEqual(result.pots[0]!.winners, ['b'])
})

test('every winner belongs to the eligible players of its pot', () => {
  const result = resolve(board, [
    { hand: hand('a', 'Kd Td'), contribution: 50 },
    { hand: hand('b', 'As Ah'), contribution: 100 },
    { hand: hand('c', '9s 9c'), contribution: 150 }
  ])
  for (const pot of result.pots) {
    assert.ok(pot.winners.length > 0)
    assert.ok(pot.winners.every(playerId => pot.eligiblePlayerIds.includes(playerId)))
  }
})

test('showdown does not mutate players, pots, or contribution amounts', () => {
  const players = [
    { hand: hand('a', 'Kd Td'), contribution: 100 },
    { hand: hand('b', 'As Ah'), contribution: 300 },
    { hand: hand('c', '9s 9c'), contribution: 500 }
  ]
  const built = buildPots(players.map(item => ({ playerId: item.hand.playerId, contribution: item.contribution, status: item.hand.status })))
  const playersBefore = structuredClone(players)
  const potsBefore = structuredClone(built)
  const result = resolveShowdown(cards(board), players.map(item => item.hand), built)
  assert.deepEqual(players, playersBefore)
  assert.deepEqual(built, potsBefore)
  assert.deepEqual(result.pots.map(pot => pot.amount), [300, 400])
})

test('showdown rejects a board without exactly five cards', () => {
  assert.throws(() => resolveShowdown(cards('2c 7d 9h Js'), [], buildPots([])), /exactly 5/)
})

test('showdown rejects a player without exactly two hole cards', () => {
  const invalid = { playerId: 'a', status: 'ACTIVE' as const, holeCards: [cards('As')[0]!] as unknown as readonly [Card, Card] }
  const valid = hand('b', 'Kd Td')
  const built = buildPots([potPlayer('a', 100), potPlayer('b', 100)])
  assert.throws(() => resolveShowdown(cards(board), [invalid, valid], built), /exactly 2 hole cards/)
})

test('showdown rejects duplicate physical cards across players', () => {
  const first = hand('a', 'As Kd')
  const second = hand('b', 'As Qd')
  const pots = buildPots([potPlayer('a', 100), potPlayer('b', 100)])
  assert.throws(() => resolveShowdown(cards(board), [first, second], pots), /Duplicate physical card/)
})

test('showdown rejects a pot with no eligible players', () => {
  const built = buildPots([potPlayer('a', 100, 'FOLDED'), potPlayer('b', 100, 'FOLDED')])
  assert.throws(() => resolveShowdown(cards(board), [hand('a', 'Kd Td', 'FOLDED'), hand('b', 'As Ah', 'FOLDED')], built), /no eligible players/)
})

test('returned excess is reported but never paid out by showdown', () => {
  const result = resolve(board, [
    { hand: hand('a', 'Kd Td'), contribution: 100 },
    { hand: hand('b', 'As Ah'), contribution: 100 },
    { hand: hand('c', '9s 9c'), contribution: 150 }
  ])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'c', amount: 50 }])
  assert.equal(result.pots.reduce((sum, pot) => sum + pot.amount, 0), 300)
})
