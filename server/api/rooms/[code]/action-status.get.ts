import { z } from 'zod'
import { getPlayerActionStatus } from '../../../services/gameService'

const querySchema = z.object({ playerId: z.string().uuid(), clientRequestId: z.string().min(3).max(128) })

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const parsed = querySchema.safeParse(getQuery(event))
  if (!code || !parsed.success) throw createError({ statusCode: 400, statusMessage: 'Укажите игрока и идентификатор команды' })
  const token = getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '') || ''
  return getPlayerActionStatus({ roomCode: code, ...parsed.data, token })
})
