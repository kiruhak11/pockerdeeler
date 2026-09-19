import { z } from 'zod'
import { openMinesCell } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
const schema = z.object({ sessionId: z.string().uuid(), cell: z.number().int().min(0).max(24) })
export default defineEventHandler(async event => {
  assertRateLimit(event, 'mines-open', { limit: 180 })
  const input = schema.safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная клетка или сессия' })
  return { session: await openMinesCell(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), input.data.sessionId, input.data.cell) }
})
