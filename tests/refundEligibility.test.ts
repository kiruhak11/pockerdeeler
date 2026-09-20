import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { evaluateRefundEligibility, isRefundRequestable } from '../server/utils/refundEligibility'

const now = new Date('2026-09-19T12:00:00.000Z')
const paidAt = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
const premium = { type: 'PREMIUM', status: 'PROCESSED', paidAt, processedAt: paidAt, createdAt: paidAt, refundStatus: null }

test('Premium refund window and payment status are enforced on the server', () => {
  assert.equal(evaluateRefundEligibility(premium, now), 'AVAILABLE')
  assert.equal(evaluateRefundEligibility({ ...premium, paidAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }, now), 'AVAILABLE')
  const manual = evaluateRefundEligibility({ ...premium, paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) }, now)
  assert.equal(manual, 'MANUAL_REVIEW_REQUIRED')
  assert.equal(isRefundRequestable(manual), true)
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

test('purchase history exposes policy review without promising an automatic refund', () => {
  const source = readFileSync(new URL('../app/pages/payments/history.vue', import.meta.url), 'utf8')
  assert.match(source, /\/legal\/refunds/)
  assert.match(source, /Отправить на рассмотрение/)
  assert.match(source, /Фактический возврат выполняется не этой формой/)
  assert.doesNotMatch(source, /деньги вернутся автоматически/)
})
