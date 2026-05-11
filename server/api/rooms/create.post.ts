import { getRequestHost, getRequestProtocol, readBody } from 'h3'
import { createRoom } from '../../services/roomService'
import { createRoomSchema } from '../../utils/validation'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = createRoomSchema.safeParse(body)

  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  const protocol = getRequestProtocol(event)
  const host = getRequestHost(event)
  const appUrl = process.env.NUXT_PUBLIC_APP_URL || `${protocol}://${host}`

  return createRoom(parsed.data, appUrl)
})
