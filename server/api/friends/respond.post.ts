import { readBody } from 'h3'
import { respondFriendRequestSchema } from '../../utils/validation'
import { respondFriendRequest } from '../../services/socialService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = respondFriendRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return respondFriendRequest(parsed.data)
})
