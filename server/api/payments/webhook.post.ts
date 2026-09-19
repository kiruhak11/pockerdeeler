import { z } from 'zod'
import { syncAndProcessPayment } from '../../services/paymentService'

export default defineEventHandler(async event => {
  const body = await readBody(event)
  const parsed = z.object({ event: z.enum(['payment.succeeded', 'payment.canceled']), object: z.object({ id: z.string().min(10) }).passthrough() }).safeParse(body)
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректное уведомление платежного провайдера' })
  return syncAndProcessPayment(parsed.data.object.id)
})
