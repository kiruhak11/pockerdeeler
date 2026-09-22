import { getQuery } from 'h3'
import { resolveOnlineRoomCode } from '../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../utils/onlineRoomApiErrors'

export default defineEventHandler(async (event) => {
  const value = getQuery(event).code
  const code = Array.isArray(value) ? value[0] : value
  try {
    return await resolveOnlineRoomCode(typeof code === 'string' ? code : '')
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
