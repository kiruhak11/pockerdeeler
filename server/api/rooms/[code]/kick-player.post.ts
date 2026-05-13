import { readBody } from 'h3'
import { kickPlayerByDealer } from '../../../services/gameService'
import { dealerKickPlayerSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = dealerKickPlayerSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const state = await kickPlayerByDealer({
    roomCode: code,
    dealerSecret: parsed.data.dealerSecret,
    playerId: parsed.data.playerId
  })

  if (state) {
    broadcastRoomState(code, state)
  }

  return {
    success: true,
    state,
    roomDeleted: !state
  }
})
