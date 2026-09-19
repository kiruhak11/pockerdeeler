import { z } from 'zod'
import { assertSameOrigin, accountCookie } from '../../../utils/accountCookie'
import { verifyUserAuthToken } from '../../../services/userAccountService'
import { createYooKassaPayment, VIRTUAL_CURRENCY_PACKAGES } from '../../../services/paymentService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = z.object({ packageId: z.enum(['chips-99', 'chips-199', 'chips-499', 'chips-999']) }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Выберите пакет фишек' })
  const pack = VIRTUAL_CURRENCY_PACKAGES[parsed.data.packageId]
  return createYooKassaPayment({ userId: auth.userId, type: 'VIRTUAL_CURRENCY', productKey: pack.packageId, priceRub: pack.priceRub, legalContext: 'VIRTUAL_CHIPS', metadata: { userId: auth.userId, type: 'VIRTUAL_CURRENCY', packageId: pack.packageId } })
})
