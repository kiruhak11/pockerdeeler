import { createError, getRequestHeader, getRequestIP, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { distributionCategories, saveDistributionPermissions } from '../../services/distributionConsentService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = z.object({ categories: z.array(z.enum(distributionCategories)).max(distributionCategories.length) }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Неизвестная категория публичности' })
  return saveDistributionPermissions({
    userId: auth.userId,
    categories: parsed.data.categories,
    ip: getRequestIP(event, { xForwardedFor: true }) || 'unknown',
    userAgent: getRequestHeader(event, 'user-agent') || 'unknown'
  })
})
