import { readBody } from 'h3'
import { roomChatMessageSchema } from '../../../utils/validation'
import { sendRoomChatMessage } from '../../../services/socialService'
import { getRoomState } from '../../../services/roomService'
import { broadcastRoomState } from '../../../ws/roomHub'
import { z } from 'zod'
import { assertRateLimit } from '../../../utils/rateLimit'

const schema = roomChatMessageSchema.extend({
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/)
})

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  setHeader(event, 'Cache-Control', 'no-store')
  assertRateLimit(event, 'room-chat-send', { limit: 90 })
  const body = await readBody(event)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const result = await sendRoomChatMessage({
    roomCode: code,
    message: parsed.data.message,
    clientRequestId: parsed.data.clientRequestId,
    participantId: parsed.data.participantId,
    token: parsed.data.token,
    dealerSecret: parsed.data.dealerSecret
  })

  const state = await getRoomState(code)
  broadcastRoomState(code, state)

  return {
    success: true,
    message: result.message,
    duplicate: result.duplicate,
    state
  }
})
