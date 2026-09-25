import { createError, getRouterParam, setHeader } from 'h3'
import { getAuthenticatedOnlineRoom } from '../../../../services/onlineRoomApiService'
import { getOnlineRoomPresenceService } from '../../../../services/onlineRoomPresenceService'
import { throwOnlineRoomApiError } from '../../../../utils/onlineRoomApiErrors'
import { requireOnlineRoomUser } from '../../../../utils/onlineRoomApiAuth'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код ONLINE комнаты обязателен' })
  const { userId } = await requireOnlineRoomUser(event)
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    const current = await getAuthenticatedOnlineRoom(userId, code)
    if (current.room.visibility !== 'PUBLIC') return { count: 0 }
    const count = await getOnlineRoomPresenceService().spectatorCount(
      current.room.roomId,
      current.room.pokerTable.players.map(player => player.playerId)
    )
    return { count }
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
