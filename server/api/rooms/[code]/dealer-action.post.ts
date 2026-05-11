import { readBody } from 'h3'
import { dealerResolvePendingAction } from '../../../services/gameService'
import { dealerActionSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = dealerActionSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const state = await dealerResolvePendingAction({
    roomCode: code,
    dealerSecret: parsed.data.dealerSecret,
    pendingActionId: parsed.data.pendingActionId,
    decision: parsed.data.decision
  })

  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})
