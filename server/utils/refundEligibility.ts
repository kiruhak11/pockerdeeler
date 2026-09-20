export type RefundEligibilityCode = 'AVAILABLE' | 'MANUAL_REVIEW_REQUIRED' | 'UNAVAILABLE' | 'EXPIRED' | 'ALREADY_REQUESTED' | 'ALREADY_REFUNDED' | 'USAGE_UNVERIFIABLE'

export type RefundPaymentState = {
  type: string
  status: string
  paidAt: Date | null
  processedAt: Date | null
  createdAt: Date
  refundStatus: string | null
}

const PREMIUM_REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function evaluateRefundEligibility(payment: RefundPaymentState, now = new Date()): RefundEligibilityCode {
  if (payment.refundStatus === 'REFUNDED') return 'ALREADY_REFUNDED'
  if (payment.refundStatus) return 'ALREADY_REQUESTED'
  if (payment.status !== 'PROCESSED') return 'UNAVAILABLE'
  // The wallet ledger records purchases and spending, but does not allocate spending to purchase lots.
  if (payment.type === 'VIRTUAL_CURRENCY') return 'USAGE_UNVERIFIABLE'
  if (payment.type !== 'PREMIUM') return 'UNAVAILABLE'
  const paidAt = payment.paidAt ?? payment.processedAt ?? payment.createdAt
  return now.getTime() - paidAt.getTime() <= PREMIUM_REFUND_WINDOW_MS ? 'AVAILABLE' : 'MANUAL_REVIEW_REQUIRED'
}

export function refundReasonLabel(code: RefundEligibilityCode): string {
  return ({
    AVAILABLE: 'Запрос доступен',
    MANUAL_REVIEW_REQUIRED: 'Запрос доступен для ручного рассмотрения',
    UNAVAILABLE: 'Возврат недоступен для этой операции',
    EXPIRED: 'Срок запроса истёк',
    ALREADY_REQUESTED: 'Запрос на возврат уже создан',
    ALREADY_REFUNDED: 'Покупка уже возвращена',
    USAGE_UNVERIFIABLE: 'Нельзя подтвердить, что фишки из этой покупки не использовались'
  } satisfies Record<RefundEligibilityCode, string>)[code]
}

export function isRefundRequestable(code: RefundEligibilityCode) {
  return code === 'AVAILABLE' || code === 'MANUAL_REVIEW_REQUIRED'
}
