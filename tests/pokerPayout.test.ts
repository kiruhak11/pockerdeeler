import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPots, type PotBuildPlayer } from '../server/utils/pokerPotBuilder'
import { resolvePayout, type PayoutPlayer } from '../server/utils/pokerPayout'
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

type Spec = Readonly<{
  playerId: string
  seat: number
  hole: string
  contribution: number
  status?: PayoutPlayer['status']
  stack?: number
}>

function player(spec: Spec): PayoutPlayer {
  return {
    playerId: spec.playerId,
    seat: spec.seat,
    status: spec.status ?? 'ACTIVE',
    stack: spec.stack ?? 1_000 - spec.contribution
  }
}

function showdownPlayer(spec: Spec): ShowdownPlayer {
  const holeCards = cards(spec.hole)
  return {
    playerId: spec.playerId,
    status: spec.status ?? 'ACTIVE',
    holeCards: [holeCards[0]!, holeCards[1]!] as readonly [Card, Card]
  }
}

function potPlayer(spec: Spec): PotBuildPlayer {
  return { playerId: spec.playerId, contribution: spec.contribution, status: spec.status ?? 'ACTIVE' }
}

function resolve(
  board: string,
  specs: readonly Spec[],
  dealerSeat = specs[0]!.seat
) {
  const built = buildPots(specs.map(potPlayer))
  const showdown = resolveShowdown(cards(board), specs.map(showdownPlayer), built)
  return resolvePayout(specs.map(player), built, showdown, dealerSeat)
}

const broadway = 'As Kd Qc Jh Ts'
const highCardBoard = '2c 7d 9h Js Qc'

test('one pot pays its single winner and updates the final stack', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  assert.deepEqual(result.potPayouts[0]!.payouts, [{ playerId: 'a', amount: 200 }])
  assert.deepEqual(result.payouts, [{ playerId: 'a', amount: 200 }, { playerId: 'b', amount: 0 }])
  assert.equal(result.players.find(item => item.playerId === 'a')!.stack, 1_100)
})

test('two tied winners split a pot evenly', () => {
  const result = resolve(broadway, [
    { playerId: 'a', seat: 1, hole: '2c 3d', contribution: 100 },
    { playerId: 'b', seat: 2, hole: '4c 5d', contribution: 100 }
  ])
  assert.deepEqual(result.potPayouts[0]!.payouts, [
    { playerId: 'b', amount: 100 },
    { playerId: 'a', amount: 100 }
  ])
  assert.equal(result.potPayouts[0]!.oddChipCount, 0)
})

test('three tied winners split a pot evenly', () => {
  const result = resolve(broadway, [
    { playerId: 'a', seat: 1, hole: '2c 3d', contribution: 100 },
    { playerId: 'b', seat: 2, hole: '4c 5d', contribution: 100 },
    { playerId: 'c', seat: 3, hole: '6c 7d', contribution: 100 }
  ])
  assert.deepEqual(result.potPayouts[0]!.payouts.map(item => item.amount), [100, 100, 100])
})

test('odd chip goes to the first tied winner clockwise after the dealer', () => {
  const result = resolve('As 7d 9h Jc 2c', [
    { playerId: 'a', seat: 1, hole: 'Ah Kd', contribution: 50 },
    { playerId: 'b', seat: 3, hole: 'Ad Kh', contribution: 50 },
    { playerId: 'c', seat: 5, hole: 'Ac Ks', contribution: 50 },
    { playerId: 'loser', seat: 7, hole: 'Qh Qd', contribution: 50 }
  ], 3)
  assert.deepEqual(result.potPayouts[0]!.winnerIds, ['c', 'a', 'b'])
  assert.deepEqual(result.potPayouts[0]!.payouts, [
    { playerId: 'c', amount: 67 },
    { playerId: 'a', amount: 67 },
    { playerId: 'b', amount: 66 }
  ])
  assert.deepEqual(result.potPayouts[0]!.oddChipRecipients, ['c', 'a'])
})

test('multiple odd chips are assigned one at a time in seat order', () => {
  const result = resolve('As 7d 9h Jc 2c', [
    { playerId: 'a', seat: 1, hole: 'Ah Kd', contribution: 50 },
    { playerId: 'b', seat: 2, hole: 'Ad Kh', contribution: 101 },
    { playerId: 'c', seat: 3, hole: 'Ac Ks', contribution: 101 },
    { playerId: 'loser', seat: 4, hole: 'Qh Qd', contribution: 101 }
  ], 3)
  assert.deepEqual(result.potPayouts.map(item => [item.amount, item.oddChipCount]), [[200, 2], [153, 1]])
  assert.deepEqual(result.potPayouts[0]!.oddChipRecipients, ['a', 'b'])
  assert.deepEqual(result.potPayouts[1]!.oddChipRecipients, ['b'])
})

test('heads-up odd chip follows the non-dealer first', () => {
  const specs: Spec[] = [
    { playerId: 'dealer', seat: 2, hole: '2c 3d', contribution: 50 },
    { playerId: 'other', seat: 5, hole: '4c 5d', contribution: 50 }
  ]
  const built = {
    pots: [{ id: 1, amount: 101, cap: 50, contributorPlayerIds: ['dealer', 'other'], eligiblePlayerIds: ['dealer', 'other'] }],
    returnedExcess: [],
    totalContribution: 101
  } as const
  const showdown = resolveShowdown(cards(broadway), specs.map(showdownPlayer), built)
  const result = resolvePayout(specs.map(player), built, showdown, 2)
  assert.deepEqual(result.potPayouts[0]!.payouts, [
    { playerId: 'other', amount: 51 },
    { playerId: 'dealer', amount: 50 }
  ])
})

test('main and side pots are paid independently to different winners', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 300, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: '8s 6c', contribution: 500 }
  ])
  assert.deepEqual(result.potPayouts.map(item => item.payouts), [
    [{ playerId: 'a', amount: 300 }],
    [{ playerId: 'b', amount: 400 }]
  ])
})

test('one player can win several side pots', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'a', seat: 1, hole: '3c 4d', contribution: 100, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: '8s 8c', contribution: 300, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: 'Kd Td', contribution: 500 }
  ])
  assert.deepEqual(result.potPayouts.map(item => item.payouts), [
    [{ playerId: 'c', amount: 300 }],
    [{ playerId: 'c', amount: 400 }]
  ])
  assert.equal(result.payouts.find(item => item.playerId === 'c')!.amount, 700)
})

test('multiple side pots can have ties independently', () => {
  const result = resolve(broadway, [
    { playerId: 'a', seat: 1, hole: '2c 3d', contribution: 50, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: '4c 5d', contribution: 100, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: '6c 7d', contribution: 150 }
  ])
  assert.deepEqual(result.potPayouts.map(item => item.payouts), [
    [{ playerId: 'b', amount: 50 }, { playerId: 'c', amount: 50 }, { playerId: 'a', amount: 50 }],
    [{ playerId: 'b', amount: 50 }, { playerId: 'c', amount: 50 }]
  ])
})

test('returned excess goes back to its owner and is not a pot win', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 },
    { playerId: 'folded', seat: 3, hole: '9s 9c', contribution: 150, status: 'FOLDED' }
  ])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'folded', amount: 50 }])
  assert.deepEqual(result.payouts, [{ playerId: 'a', amount: 300 }, { playerId: 'b', amount: 0 }, { playerId: 'folded', amount: 0 }])
  assert.equal(result.players.find(item => item.playerId === 'folded')!.stack, 900)
  assert.equal(result.players.find(item => item.playerId === 'folded')!.returnedExcess, 50)
})

test('folded players never receive a contested pot payout', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'folded', seat: 1, hole: 'Kd Td', contribution: 100, status: 'FOLDED' },
    { playerId: 'active', seat: 2, hole: 'As Ah', contribution: 100 },
    { playerId: 'other', seat: 3, hole: '8s 6c', contribution: 100 }
  ])
  assert.equal(result.payouts.find(item => item.playerId === 'folded')!.amount, 0)
  assert.equal(result.potPayouts[0]!.winnerIds.includes('folded'), false)
})

test('odd chip is calculated separately for each pot', () => {
  const result = resolve('As 7d 9h Jc 2c', [
    { playerId: 'a', seat: 1, hole: 'Ah Kd', contribution: 50, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'Ad Kh', contribution: 101, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: 'Ac Ks', contribution: 101 },
    { playerId: 'loser', seat: 4, hole: 'Qh Qd', contribution: 101 }
  ], 3)
  assert.deepEqual(result.potPayouts.map(item => item.oddChipCount), [2, 1])
})

test('final stacks and payout totals conserve all chips', () => {
  const specs: Spec[] = [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 300 },
    { playerId: 'c', seat: 3, hole: '9s 9c', contribution: 500 }
  ]
  const initialStacks = specs.reduce((sum, item) => sum + (item.stack ?? 1_000 - item.contribution), 0)
  const initialStacksBeforeContributions = specs.reduce((sum, item) => sum + (item.stack ?? 1_000 - item.contribution) + item.contribution, 0)
  const result = resolve(highCardBoard, specs)
  const finalStacks = result.players.reduce((sum, item) => sum + item.stack, 0)
  assert.equal(result.totalPayout, result.potPayouts.reduce((sum, pot) => sum + pot.amount, 0))
  assert.equal(finalStacks, initialStacksBeforeContributions)
  assert.equal(finalStacks, initialStacks + result.totalPayout + result.totalReturnedExcess)
  assert.equal(result.totalPayout + result.totalReturnedExcess, 900)
})

test('complex six-player scenario distributes each pot only to its winners', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 50, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: 'Ks Kh', contribution: 200, status: 'ALL_IN' },
    { playerId: 'd', seat: 4, hole: 'Qs Qh', contribution: 300 },
    { playerId: 'e', seat: 5, hole: 'Jd Jh', contribution: 300 },
    { playerId: 'f', seat: 6, hole: '8s 6c', contribution: 300, status: 'FOLDED' }
  ])
  assert.equal(result.potPayouts.length, 4)
  assert.deepEqual(result.potPayouts.map(item => item.amount), [300, 250, 400, 300])
  for (const pot of result.potPayouts) {
    assert.ok(pot.payouts.every(item => pot.winnerIds.includes(item.playerId)))
  }
  assert.equal(result.payouts.find(item => item.playerId === 'f')!.amount, 0)
})

test('payout does not mutate players, built pots, or showdown result', () => {
  const specs: Spec[] = [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 300 },
    { playerId: 'c', seat: 3, hole: '9s 9c', contribution: 500 }
  ]
  const players = specs.map(player)
  const built = buildPots(specs.map(potPlayer))
  const showdown = resolveShowdown(cards(highCardBoard), specs.map(showdownPlayer), built)
  const before = structuredClone({ players, built, showdown })
  resolvePayout(players, built, showdown, 1)
  assert.deepEqual({ players, built, showdown }, before)
})

test('payout rejects a mismatched showdown result', () => {
  const specs: Spec[] = [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ]
  const built = buildPots(specs.map(potPlayer))
  const showdown = resolveShowdown(cards(highCardBoard), specs.map(showdownPlayer), built)
  assert.throws(() => resolvePayout(specs.map(player), built, { ...showdown, pots: [] }, 1), /do not match/)
})

test('odd chip order is based on seats rather than player ids or input order', () => {
  const result = resolve('As 7d 9h Jc 2c', [
    { playerId: 'z-player', seat: 7, hole: 'Qh Qd', contribution: 50 },
    { playerId: 'a-player', seat: 1, hole: 'Ah Kd', contribution: 50 },
    { playerId: 'm-player', seat: 5, hole: 'Ac Ks', contribution: 50 },
    { playerId: 'b-player', seat: 3, hole: 'Ad Kh', contribution: 50 }
  ], 3)
  assert.deepEqual(result.potPayouts[0]!.oddChipRecipients, ['m-player', 'a-player'])
})

test('unknown dealer seat is rejected', () => {
  const specs: Spec[] = [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ]
  const built = buildPots(specs.map(potPlayer))
  const showdown = resolveShowdown(cards(highCardBoard), specs.map(showdownPlayer), built)
  assert.throws(() => resolvePayout(specs.map(player), built, showdown, 9), /Dealer seat 9/)
})

test('returned excess mismatch is rejected instead of double-crediting', () => {
  const specs: Spec[] = [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 },
    { playerId: 'c', seat: 3, hole: '8s 6c', contribution: 150 }
  ]
  const built = buildPots(specs.map(potPlayer))
  const showdown = resolveShowdown(cards(highCardBoard), specs.map(showdownPlayer), built)
  assert.throws(() => resolvePayout(specs.map(player), built, { ...showdown, returnedExcess: [] }, 1), /returned excess/)
})

test('eligible losers receive no payout from a pot', () => {
  const result = resolve(highCardBoard, [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'loser', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  assert.equal(result.payouts.find(item => item.playerId === 'loser')!.amount, 0)
  assert.equal(result.players.find(item => item.playerId === 'loser')!.stack, 900)
})

test('payout preserves player seats and statuses in the result', () => {
  const specs: Spec[] = [
    { playerId: 'folded', seat: 4, hole: '8s 6c', contribution: 100, status: 'FOLDED' },
    { playerId: 'active', seat: 2, hole: 'Kd Td', contribution: 100, status: 'ACTIVE' }
  ]
  const result = resolve(highCardBoard, specs, 2)
  assert.deepEqual(result.players.map(item => [item.playerId, item.seat, item.status]), [
    ['active', 2, 'ACTIVE'],
    ['folded', 4, 'FOLDED']
  ])
})
