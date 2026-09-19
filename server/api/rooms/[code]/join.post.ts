import { getRequestIP, readBody } from 'h3'
import { joinRoom } from '../../../services/roomService'
import { joinRoomSchema } from '../../../utils/validation'
import { getRoomState } from '../../../services/roomService'
import { broadcastRoomState } from '../../../ws/roomHub'
import { assertRateLimit } from '../../../utils/rateLimit'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }
  assertRateLimit(event, 'room-join', { limit: 120, subject: `${code}:${getRequestIP(event, { xForwardedFor: true }) || 'unknown'}` })

  const body = await readBody(event)
  const parsed = joinRoomSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const result = await joinRoom(
    code,
    parsed.data.name.trim(),
    parsed.data.role ?? 'player',
    parsed.data.authToken,
    parsed.data.password,
    parsed.data.buyInAmount,
    parsed.data.clientRequestId
  )
  broadcastRoomState(code, await getRoomState(code))
  return result
})
