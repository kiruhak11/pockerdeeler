import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { evaluateRefundEligibility, refundReasonLabel } from '../utils/refundEligibility'
import { dispatchUserTelegram } from './notificationService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'

export { refundReasonLabel } from '../utils/refundEligibility'

export async function getRefundEligibility(userId: string, paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { refundRequest: true }
  })
  if (!payment || payment.userId !== userId) throw createError({ statusCode: 404, message: 'Покупка не найдена' })

  const code = evaluateRefundEligibility({
    type: payment.type, status: payment.status, paidAt: payment.paidAt,
    processedAt: payment.processedAt, createdAt: payment.createdAt,
    refundStatus: payment.refundRequest?.status ?? null
  })
  return { eligible: code === 'AVAILABLE', code, message: refundReasonLabel(code), payment }
}

export async function requestRefund(userId: string, paymentId: string, reason: string) {
  const normalizedReason = reason.trim()
  if (normalizedReason.length < 5 || normalizedReason.length > 1000) throw createError({ statusCode: 400, message: 'Укажите причину возврата от 5 до 1000 символов' })

  const check = await getRefundEligibility(userId, paymentId)
  if (check.payment.refundRequest) return check.payment.refundRequest
  if (!check.eligible) throw createError({ statusCode: 409, message: check.message, data: { code: check.code } })

  try {
    const created = await prisma.refundRequest.create({
      data: {
        id: randomUUID(),
        userId,
        paymentId,
        purchaseType: check.payment.type,
        reason: normalizedReason,
        status: 'REQUESTED'
      }
    })
    dispatchUserTelegram(userId, 'purchases', 'Запрос на возврат покупки принят.')
    void notifyAdminTelegram('payments', `Запрошен возврат платежа ${paymentId}.`)
    return created
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const existing = await prisma.refundRequest.findUnique({ where: { paymentId } })
      if (existing?.userId === userId) return existing
      throw createError({ statusCode: 409, message: 'Запрос на возврат уже создан' })
    }
    throw error
  }
}
