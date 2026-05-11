import { readBody } from 'h3'
import { requestPlayerAction } from '../../../services/gameService'
import { playerActionSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = playerActionSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const result = await requestPlayerAction({
    roomCode: code,
    playerId: parsed.data.playerId,
    token: parsed.data.token,
    type: parsed.data.type,
    amount: parsed.data.amount,
    clientRequestId: parsed.data.clientRequestId
  })

  if (result.state) {
    broadcastRoomState(code, result.state)
  }

  return result
})
