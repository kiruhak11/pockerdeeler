import { z } from 'zod'
import { createError, defineEventHandler, readBody } from 'h3'
import { syncAndProcessPayment } from '../../services/paymentService'
import { assertPaymentWebhookRateLimit } from '../../utils/paymentWebhookRateLimit'

export default defineEventHandler(async event => {
  const body = await readBody(event)
  const parsed = z.object({ event: z.enum(['payment.succeeded', 'payment.canceled']), object: z.object({ id: z.string().min(10) }).passthrough() }).safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректное уведомление платежного провайдера' })
  await assertPaymentWebhookRateLimit(event, parsed.data.object.id)
  return syncAndProcessPayment(parsed.data.object.id)
})
