import { setHeader } from 'h3'
import { listPublicOnlineRooms } from '../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../utils/onlineRoomApiErrors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    return { rooms: await listPublicOnlineRooms() }
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
