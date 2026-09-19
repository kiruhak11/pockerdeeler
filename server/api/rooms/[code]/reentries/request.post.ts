import { readBody } from 'h3'
import { requestReentry } from '../../../../services/predictionService'
import { reentryRequestSchema } from '../../../../utils/validation'
import { getRoomState } from '../../../../services/roomService'
import { broadcastRoomState } from '../../../../ws/roomHub'
import { assertRateLimit } from '../../../../utils/rateLimit'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  const parsed = reentryRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Некорректный запрос' })
  assertRateLimit(event, 'reentry-request', { limit: 10, subject: `${code}:${parsed.data.memberId}` })
  const result = await requestReentry({ roomCode: code, ...parsed.data })
  broadcastRoomState(code, await getRoomState(code))
  return { success: true, ...result }
})
