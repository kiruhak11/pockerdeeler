import { readBody } from 'h3'
import { inviteFriendToRoomSchema } from '../../../../utils/validation'
import { resolveAccountToken } from '../../../../utils/accountCookie'
import { inviteFriendToOnlineRoom } from '../../../../services/onlineRoomInviteService'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.trim().toUpperCase()
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код онлайн-комнаты обязателен.' })
  const parsed = inviteFriendToRoomSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload.' })
  return inviteFriendToOnlineRoom({
    token: resolveAccountToken(event, parsed.data.token),
    roomCode: code,
    friendUserId: parsed.data.friendUserId
  })
})
