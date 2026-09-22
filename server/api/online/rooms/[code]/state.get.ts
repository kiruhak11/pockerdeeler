import { createError, getRouterParam, setHeader } from 'h3'
import { getAuthenticatedOnlineRoom } from '../../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../../utils/onlineRoomApiErrors'
import { requireOnlineRoomUser } from '../../../../utils/onlineRoomApiAuth'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код ONLINE комнаты обязателен' })
  const { userId } = await requireOnlineRoomUser(event)
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return await getAuthenticatedOnlineRoom(userId, code)
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
