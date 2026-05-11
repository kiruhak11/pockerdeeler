import { readBody } from 'h3'
import { undoLastDealerAction } from '../../../services/gameService'
import { dealerSecretSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = dealerSecretSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'dealerSecret обязателен' })
  }

  const state = await undoLastDealerAction({ roomCode: code, dealerSecret: parsed.data.dealerSecret })
  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})
