import { readBody } from 'h3'
import { leaveRoom } from '../../../services/gameService'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)

  const state = await leaveRoom({
    roomCode: code,
    participantId: body?.participantId,
    playerId: body?.playerId,
    token: body?.token,
    dealerSecret: body?.dealerSecret
  })

  broadcastRoomState(code, state)

  return {
    success: true,
    state
  }
})
