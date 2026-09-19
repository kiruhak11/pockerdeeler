import { z } from 'zod'
import { startMines } from '../../services/minesService'
import { accountCookie } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
const schema = z.object({ stake: z.number().int().min(10).max(100000), mines: z.number().int().min(1).max(24), clientSeed: z.string().min(1).max(128), commitmentId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128) })
export default defineEventHandler(async event => {
  assertRateLimit(event, 'mines-start', { limit: 30 })
  const input = schema.safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректные параметры игры' })
  return startMines(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), input.data)
})
