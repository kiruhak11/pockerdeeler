import { authTokenSchema } from '../../../utils/validation'
import { setPlayerAway } from '../../../services/gameService'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async event => {
  const parsed = authTokenSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Необходим токен аккаунта' })
  const code = getRouterParam(event, 'code')!.toUpperCase()
  const state = await setPlayerAway(code, parsed.data.token)
  broadcastRoomState(code, state)
  return { success: true, state }
})
