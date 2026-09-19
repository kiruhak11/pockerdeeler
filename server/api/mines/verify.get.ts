import { z } from 'zod'
import { verifyMines } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
export default defineEventHandler(event => {
  const input = z.object({ sessionId: z.string().uuid() }).safeParse(getQuery(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная сессия' })
  return verifyMines(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), input.data.sessionId)
})
