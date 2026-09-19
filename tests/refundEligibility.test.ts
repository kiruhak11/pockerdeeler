import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateRefundEligibility } from '../server/utils/refundEligibility'

const now = new Date('2026-09-19T12:00:00.000Z')
const paidAt = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
const premium = { type: 'PREMIUM', status: 'PROCESSED', paidAt, processedAt: paidAt, createdAt: paidAt, refundStatus: null }

test('Premium refund window and payment status are enforced on the server', () => {
  assert.equal(evaluateRefundEligibility(premium, now), 'AVAILABLE')
  assert.equal(evaluateRefundEligibility({ ...premium, paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) }, now), 'EXPIRED')
  assert.equal(evaluateRefundEligibility({ ...premium, status: 'PENDING' }, now), 'UNAVAILABLE')
  assert.equal(evaluateRefundEligibility({ ...premium, status: 'CANCELED' }, now), 'UNAVAILABLE')
})

test('existing and refunded requests cannot become eligible again', () => {
  assert.equal(evaluateRefundEligibility({ ...premium, refundStatus: 'REQUESTED' }, now), 'ALREADY_REQUESTED')
  assert.equal(evaluateRefundEligibility({ ...premium, refundStatus: 'REJECTED' }, now), 'ALREADY_REQUESTED')
  assert.equal(evaluateRefundEligibility({ ...premium, refundStatus: 'REFUNDED' }, now), 'ALREADY_REFUNDED')
})

test('virtual chips cannot be refunded based on a fungible wallet balance', () => {
  assert.equal(evaluateRefundEligibility({ ...premium, type: 'VIRTUAL_CURRENCY' }, now), 'USAGE_UNVERIFIABLE')
})
