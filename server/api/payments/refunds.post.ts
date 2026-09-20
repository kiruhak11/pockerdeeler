import { createError, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { requestRefund } from '../../services/refundService'
import { refundRequestBodySchema } from '../../utils/refundRequestSchema'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = refundRequestBodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Укажите причину возврата' })
  const request = await requestRefund(auth.userId, parsed.data.paymentId, parsed.data.reason)
  return { id: request.id, status: request.status, requestedAt: request.requestedAt.toISOString() }
})
