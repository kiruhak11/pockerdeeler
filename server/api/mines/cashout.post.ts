import { z } from 'zod'
import { cashoutMines } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
export default defineEventHandler(async event => {
  assertRateLimit(event, 'mines-cashout', { limit: 60 })
  const input = z.object({ sessionId: z.string().uuid() }).safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная сессия' })
  return { session: await cashoutMines(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), input.data.sessionId) }
})
