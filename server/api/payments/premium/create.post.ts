import { z } from 'zod'
import { assertSameOrigin, accountCookie } from '../../../utils/accountCookie'
import { verifyUserAuthToken } from '../../../services/userAccountService'
import { createYooKassaPayment, PREMIUM_PAYMENT_PLANS } from '../../../services/paymentService'
import { assertWebAccount } from '../../../utils/platformAccount'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  await assertWebAccount(auth.userId)
  const parsed = z.object({ plan: z.enum(['LITE', 'PRO', 'ELITE']), requestId: z.string().uuid() }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Выберите тариф Premium' })
  const plan = PREMIUM_PAYMENT_PLANS[parsed.data.plan]
  return createYooKassaPayment({ userId: auth.userId, type: 'PREMIUM', productKey: plan.plan, priceRub: plan.priceRub, legalContext: 'PREMIUM', requestId: parsed.data.requestId, metadata: { userId: auth.userId, type: 'PREMIUM', plan: plan.plan } })
})
