import { z } from 'zod'
import { assertSameOrigin, accountCookie } from '../../../utils/accountCookie'
import { verifyUserAuthToken } from '../../../services/userAccountService'
import { createYooKassaPayment, PREMIUM_PAYMENT_PLANS } from '../../../services/paymentService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = z.object({ plan: z.enum(['LITE', 'PRO', 'ELITE']) }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Выберите тариф Premium' })
  const plan = PREMIUM_PAYMENT_PLANS[parsed.data.plan]
  return createYooKassaPayment({ userId: auth.userId, type: 'PREMIUM', productKey: plan.plan, priceRub: plan.priceRub, legalContext: 'PREMIUM', metadata: { userId: auth.userId, type: 'PREMIUM', plan: plan.plan } })
})
