import { readBody } from 'h3'
import { topUpPlayer } from '../../../services/roomService'
import { buyInSchema } from '../../../utils/validation'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  const parsed = buyInSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Некорректный запрос' })
  const state = await topUpPlayer({ roomCode: code, ...parsed.data })
  broadcastRoomState(code, state)
  return { success: true, state }
})
