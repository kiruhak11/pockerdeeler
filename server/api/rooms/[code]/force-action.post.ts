import { readBody } from 'h3'
import { dealerForceActionForPlayer } from '../../../services/gameService'
import { dealerForceActionSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = dealerForceActionSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const state = await dealerForceActionForPlayer({
    roomCode: code,
    dealerSecret: parsed.data.dealerSecret,
    playerId: parsed.data.playerId,
    type: parsed.data.type,
    amount: parsed.data.amount
  })

  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})
