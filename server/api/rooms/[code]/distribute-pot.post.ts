import { readBody } from 'h3'
import { distributePotByDealer } from '../../../services/gameService'
import { distributePotSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = distributePotSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const state = await distributePotByDealer({
    roomCode: code,
    dealerSecret: parsed.data.dealerSecret,
    winners: parsed.data.winners
  })
  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})
