import { saveAccountCookie, COOKIE_MARKER, isolatedAuthTests } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
import { readBody } from 'h3'
import { loginSchema } from '../../utils/validation'
import { loginUser } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'account-login', { limit: 15 })
  const body = await readBody(event)
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const result = await loginUser(parsed.data)
  if (isolatedAuthTests()) return result
  saveAccountCookie(event, result.token)
  return { user: result.user, token: COOKIE_MARKER }
})
