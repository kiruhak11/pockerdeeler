import { createError } from 'h3'
import { z } from 'zod'
import { accountCookie } from '../../../utils/accountCookie'
import { verifyUserAuthToken } from '../../../services/userAccountService'
import { getRefundEligibility, refundReasonLabel } from '../../../services/refundService'

export default defineEventHandler(async event => {
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = z.object({ paymentId: z.string().uuid() }).safeParse(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректный платеж' })
  const result = await getRefundEligibility(auth.userId, parsed.data.paymentId)
  return { eligible: result.eligible, code: result.code, message: refundReasonLabel(result.code) }
})
