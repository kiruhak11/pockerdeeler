import { readBody } from 'h3'
import { inviteFriendToRoomSchema } from '../../../utils/validation'
import { inviteFriendToRoom } from '../../../services/socialService'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = inviteFriendToRoomSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return inviteFriendToRoom({
    token: parsed.data.token,
    roomCode: code,
    friendUserId: parsed.data.friendUserId
  })
})
