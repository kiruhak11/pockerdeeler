import { readBody } from 'h3'
import { leaveRoom } from '../../../services/gameService'
import { broadcastRoomState } from '../../../ws/roomHub'
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const parsed = z.object({
    participantId: z.string().uuid().optional(), playerId: z.string().uuid().nullish(),
    token: z.string().min(1).max(512).optional(), dealerSecret: z.string().min(1).max(512).optional(),
    authToken: z.string().min(1).max(512).optional()
  }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректные данные выхода' })
  const body = parsed.data

  const state = await leaveRoom({
    roomCode: code,
    participantId: body?.participantId,
    playerId: body.playerId ?? undefined,
    token: body?.token,
    dealerSecret: body?.dealerSecret,
    authToken: body?.authToken
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
