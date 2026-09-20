import { createError, getRequestHeader, getRequestIP, readBody } from 'h3'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { acceptCurrentLegalDocuments } from '../../services/legalService'
import { legalAcceptanceBodySchema } from '../../utils/legalAcceptanceSchema'

export { legalAcceptanceBodySchema } from '../../utils/legalAcceptanceSchema'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = legalAcceptanceBodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Подтвердите обязательные условия' })
  if (parsed.data.packageId && parsed.data.context !== 'VIRTUAL_CHIPS') throw createError({ statusCode: 400, message: 'Пакет несовместим с контекстом checkout' })
  if (parsed.data.plan && parsed.data.context !== 'PREMIUM') throw createError({ statusCode: 400, message: 'Тариф несовместим с контекстом checkout' })
  return acceptCurrentLegalDocuments({
    userId: auth.userId,
    context: parsed.data.context,
    confirmations: parsed.data,
    requestId: parsed.data.requestId,
    productKey: parsed.data.context === 'VIRTUAL_CHIPS' ? parsed.data.packageId : parsed.data.context === 'PREMIUM' ? parsed.data.plan : undefined,
    checkout: parsed.data.checkout === true,
    ip: getRequestIP(event, { xForwardedFor: true }) || 'unknown',
    userAgent: getRequestHeader(event, 'user-agent') || 'unknown'
  })
})
