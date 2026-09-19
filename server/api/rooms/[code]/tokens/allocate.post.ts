import { z } from 'zod'
import { setTokenPredictions } from '../../../../services/tokenPredictionService'
import { accountCookie } from '../../../../utils/accountCookie'
import { assertRateLimit } from '../../../../utils/rateLimit'
import { getRoomState } from '../../../../services/roomService'
import { broadcastRoomState } from '../../../../ws/roomHub'
const schema = z.object({ roundId: z.string().uuid(), requestId: z.string().min(8).max(128), allocations: z.array(z.object({ candidateId: z.string().uuid(), tokens: z.number().int().min(1).max(3) })).max(3) })
export default defineEventHandler(async event => {
  assertRateLimit(event, 'token-allocation', { limit: 90 })
  const input = schema.safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный прогноз' })
  const code = getRouterParam(event,'code')?.toUpperCase() || ''
  const result = await setTokenPredictions(code, accountCookie(event) || getHeader(event,'authorization')?.replace(/^Bearer /i,''), input.data)
  broadcastRoomState(code, await getRoomState(code))
  return result
})
