import { createError, getRequestHeader, getRequestIP, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { acceptCurrentLegalDocuments, legalAcceptanceContexts } from '../../services/legalService'

const bodySchema = z.object({
  context: z.enum(legalAcceptanceContexts),
  requestId: z.string().uuid(),
  termsAccepted: z.boolean().optional(),
  virtualCurrencyAcknowledged: z.boolean().optional(),
  ageConfirmed: z.boolean().optional(),
  personalDataConsent: z.boolean().optional()
}).strict()

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Подтвердите обязательные условия' })
  return acceptCurrentLegalDocuments({
    userId: auth.userId,
    context: parsed.data.context,
    confirmations: parsed.data,
    requestId: parsed.data.requestId,
    ip: getRequestIP(event, { xForwardedFor: true }) || 'unknown',
    userAgent: getRequestHeader(event, 'user-agent') || 'unknown'
  })
})
