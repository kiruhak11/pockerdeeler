import { createError, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie as getAccountCookie, assertSameOrigin as assertRequestOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { setLeaderboardVisibility } from '../../services/leaderboardVisibilityService'

export default defineEventHandler(async event => {
  assertRequestOrigin(event)
  const auth = await verifyUserAuthToken(getAccountCookie(event))
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  const parsed = z.object({ leaderboardVisible: z.boolean() }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная настройка видимости рейтингов' })
  return { leaderboardVisible: await setLeaderboardVisibility(auth.userId, parsed.data.leaderboardVisible) }
})
