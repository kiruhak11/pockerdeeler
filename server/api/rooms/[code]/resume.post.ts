import { authTokenSchema } from '../../../utils/validation'
import { resumeAccountRoom } from '../../../services/gameService'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async event => {
  const parsed = authTokenSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Необходим токен аккаунта' })
  const result = await resumeAccountRoom(getRouterParam(event, 'code')!.toUpperCase(), parsed.data.token)
  broadcastRoomState(result.roomCode, result.state)
  return result
})
