import { readBody } from 'h3'
import { joinRoom } from '../../../services/roomService'
import { joinRoomSchema } from '../../../utils/validation'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  }

  const body = await readBody(event)
  const parsed = joinRoomSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return joinRoom(code, parsed.data.name.trim(), parsed.data.role ?? 'player', parsed.data.authToken)
})
