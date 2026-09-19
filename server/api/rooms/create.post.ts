import { getRequestHost, getRequestProtocol, readBody } from 'h3'
import { createRoom } from '../../services/roomService'
import { createRoomSchema } from '../../utils/validation'
import { assertRateLimit } from '../../utils/rateLimit'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'room-create', { limit: 30 })
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
