import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPots, type PotBuildPlayer } from '../server/utils/pokerPotBuilder'

function player(playerId: string, contribution: number, status: PotBuildPlayer['status'] = 'ACTIVE'): PotBuildPlayer {
  return { playerId, contribution, status }
}

function totalPots(result: ReturnType<typeof buildPots>): number {
  return result.pots.reduce((sum, pot) => sum + pot.amount, 0)
}

test('two equal contributions create one main pot', () => {
  const result = buildPots([player('a', 100), player('b', 100)])
  assert.deepEqual(result.pots, [{ id: 1, amount: 200, cap: 100, contributorPlayerIds: ['a', 'b'], eligiblePlayerIds: ['a', 'b'] }])
  assert.deepEqual(result.returnedExcess, [])
})

test('three equal contributions create one main pot', () => {
  const result = buildPots([player('a', 40), player('b', 40), player('c', 40)])
  assert.equal(result.pots.length, 1)
  assert.equal(result.pots[0]!.amount, 120)
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, ['a', 'b', 'c'])
})

test('one short all-in creates a main pot and one side pot', () => {
  const result = buildPots([player('a', 100, 'ALL_IN'), player('b', 300, 'ALL_IN'), player('c', 300, 'ACTIVE')])
  assert.deepEqual(result.pots.map(pot => [pot.amount, pot.cap]), [[300, 100], [400, 300]])
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, ['a', 'b', 'c'])
  assert.deepEqual(result.pots[1]!.eligiblePlayerIds, ['b', 'c'])
  assert.deepEqual(result.returnedExcess, [])
})

test('two different all-ins produce multiple side pots and return unmatched excess', () => {
  const result = buildPots([player('a', 100, 'ALL_IN'), player('b', 300, 'ALL_IN'), player('c', 500, 'ACTIVE')])
  assert.deepEqual(result.pots.map(pot => pot.amount), [300, 400])
  assert.deepEqual(result.pots.map(pot => pot.eligiblePlayerIds), [['a', 'b', 'c'], ['b', 'c']])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'c', amount: 200 }])
})

test('folded contribution remains in the pot but folded player cannot win it', () => {
  const result = buildPots([player('a', 100), player('b', 100, 'FOLDED'), player('c', 100)])
  assert.equal(result.pots[0]!.amount, 300)
  assert.deepEqual(result.pots[0]!.contributorPlayerIds, ['a', 'b', 'c'])
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, ['a', 'c'])
})

test('multiple folded players are excluded from every eligible list', () => {
  const result = buildPots([
    player('a', 100, 'FOLDED'),
    player('b', 200, 'FOLDED'),
    player('c', 200),
    player('d', 200)
  ])
  assert.deepEqual(result.pots.map(pot => pot.eligiblePlayerIds), [['a', 'b', 'c', 'd'], ['b', 'c', 'd']].map(ids => ids.filter(id => id === 'c' || id === 'd')))
  assert.deepEqual(result.pots[0]!.contributorPlayerIds, ['a', 'b', 'c', 'd'])
})

test('six-player contributions create mathematically correct levels', () => {
  const result = buildPots([
    player('a', 50), player('b', 100), player('c', 200),
    player('d', 200), player('e', 400), player('f', 0)
  ])
  assert.deepEqual(result.pots.map(pot => [pot.amount, pot.cap]), [[250, 50], [200, 100], [300, 200]])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'e', amount: 200 }])
})

test('zero contribution players do not create a pot or become eligible', () => {
  const result = buildPots([player('a', 0), player('b', 50), player('c', 50)])
  assert.equal(result.pots.length, 1)
  assert.equal(result.pots[0]!.amount, 100)
  assert.deepEqual(result.pots[0]!.contributorPlayerIds, ['b', 'c'])
  assert.equal(result.pots[0]!.eligiblePlayerIds.includes('a'), false)
})

test('pot amounts plus returned excess equal every contribution', () => {
  const players = [player('a', 40), player('b', 100), player('c', 260), player('d', 400, 'FOLDED')]
  const result = buildPots(players)
  assert.equal(totalPots(result) + result.returnedExcess.reduce((sum, item) => sum + item.amount, 0), 800)
  assert.equal(result.totalContribution, 800)
})

test('an unmatched top contribution is returned rather than contested', () => {
  const result = buildPots([player('a', 100), player('b', 100), player('c', 150)])
  assert.equal(totalPots(result), 300)
  assert.deepEqual(result.returnedExcess, [{ playerId: 'c', amount: 50 }])
})

test('a single contributor is entirely returned as excess', () => {
  const result = buildPots([player('a', 100), player('b', 0)])
  assert.deepEqual(result.pots, [])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'a', amount: 100 }])
})

test('all folded contributors still form a structural pot without eligible winners', () => {
  const result = buildPots([player('a', 20, 'FOLDED'), player('b', 20, 'OUT')])
  assert.equal(result.pots[0]!.amount, 40)
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, [])
})

test('duplicate player ids are rejected', () => {
  assert.throws(() => buildPots([player('a', 10), player('a', 20)]), /ids must be unique/)
})

test('negative and unsafe contributions are rejected', () => {
  assert.throws(() => buildPots([player('a', -1)]), /non-negative/)
  assert.throws(() => buildPots([player('a', Number.MAX_SAFE_INTEGER + 1)]), /non-negative/)
})

test('input order is preserved deterministically within each level', () => {
  const result = buildPots([player('c', 100), player('a', 100), player('b', 50)])
  assert.deepEqual(result.pots[0]!.contributorPlayerIds, ['c', 'a', 'b'])
  assert.deepEqual(result.pots[0]!.eligiblePlayerIds, ['c', 'a', 'b'])
})

test('every positive contribution is accounted for exactly once', () => {
  const players = [player('a', 20), player('b', 60), player('c', 100), player('d', 100, 'FOLDED')]
  const result = buildPots(players)
  const accounted = totalPots(result) + result.returnedExcess.reduce((sum, item) => sum + item.amount, 0)
  assert.equal(accounted, players.reduce((sum, item) => sum + item.contribution, 0))
})
