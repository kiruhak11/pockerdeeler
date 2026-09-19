import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../utils/adminAuth'
import { assertRateLimit } from '../../utils/rateLimit'
import { moderateRoomChatMessage } from '../../services/socialService'
import { getRoomState } from '../../services/roomService'
import { broadcastRoomState } from '../../ws/roomHub'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  assertRateLimit(event, 'admin-chat-moderation', { subject: actor.id, limit: 20 })
  const parsed = z.object({ id: z.string().uuid(), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().min(1).max(128) }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Укажите сообщение, причину и текущий пароль' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  const result = await moderateRoomChatMessage(actor.id, parsed.data)
  // Also broadcast duplicate requests: a previous commit may have lost its reply.
  const state = await getRoomState(result.roomCode)
  broadcastRoomState(result.roomCode, state)
  return { success: true, duplicate: result.duplicate }
})
