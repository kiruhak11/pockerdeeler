import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRatingChange, calculateTableRatingChange } from '../app/utils/ratingCalculations'

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
