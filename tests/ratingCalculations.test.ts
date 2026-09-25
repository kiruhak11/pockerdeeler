import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRatingChange, calculateTableRatingChange, calculateZeroSumTableRatingDeltas } from '../app/utils/ratingCalculations'

const base = { won: false, split: false, folded: false, hadAction: true, hadRaise: false, hadAllIn: false }

test('table win raises rating', () => {
  assert.deepEqual(calculateTableRatingChange({ ...base, won: true }), { delta: 12, reason: 'Победа за столом' })
})

test('split win receives a smaller positive change', () => {
  assert.equal(calculateTableRatingChange({ ...base, won: true, split: true }).delta, 7)
})

test('loss, fold and lost all-in reduce rating', () => {
  assert.equal(calculateTableRatingChange(base).delta, -6)
  assert.equal(calculateTableRatingChange({ ...base, folded: true }).delta, -3)
  assert.equal(calculateTableRatingChange({ ...base, hadAllIn: true }).delta, -10)
})

test('rating can be lost completely but never becomes negative', () => {
  assert.equal(applyRatingChange(6, -6), 0)
  assert.equal(applyRatingChange(3, -10), 0)
  assert.equal(applyRatingChange(1000, 12), 1012)
})

test('pairwise table rating is zero-sum head-to-head for humans or bots alike', () => {
  const deltas = calculateZeroSumTableRatingDeltas(['human', 'bot'], new Map([['human', 1000], ['bot', 1000]]), [
    { amount: 100, contributorPlayerIds: ['human', 'bot'], eligiblePlayerIds: ['human', 'bot'], winnerIds: ['human'] }
  ])
  assert.equal(deltas.get('human'), 12)
  assert.equal(deltas.get('bot'), -12)
  assert.equal([...deltas.values()].reduce((sum, value) => sum + value, 0), 0)
})

test('multiplayer rating distributes a win across losers and split pots do not deflate the table', () => {
  const ids = ['a', 'b', 'c', 'd']
  const ratings = new Map(ids.map(id => [id, 1000]))
  const outright = calculateZeroSumTableRatingDeltas(ids, ratings, [
    { amount: 100, contributorPlayerIds: ids, eligiblePlayerIds: ids, winnerIds: ['a'] }
  ])
  assert.equal([...outright.values()].reduce((sum, value) => sum + value, 0), 0)
  assert.ok((outright.get('a') ?? 0) > 0)
  assert.ok(ids.slice(1).every(id => (outright.get(id) ?? 0) <= 0))

  const split = calculateZeroSumTableRatingDeltas(ids, ratings, [
    { amount: 50, contributorPlayerIds: ids, eligiblePlayerIds: ids, winnerIds: ['a', 'b'] },
    { amount: 50, contributorPlayerIds: ['a', 'b', 'c'], eligiblePlayerIds: ['a', 'b', 'c'], foldedPlayerIds: ['c'], winnerIds: ['a'] }
  ])
  assert.equal([...split.values()].reduce((sum, value) => sum + value, 0), 0)
  assert.ok((split.get('c') ?? 0) < 0)
})
