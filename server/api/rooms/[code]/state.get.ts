import { getRoomState } from '../../../services/roomService'
import { authorizeRoomRead } from '../../../services/roomAccessService'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  await authorizeRoomRead(code, getHeader(event, 'authorization')?.replace(/^Bearer /i, '') || '')
  setHeader(event, 'Cache-Control', 'no-store')
  return getRoomState(code)
})
