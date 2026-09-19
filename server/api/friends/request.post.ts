import { readBody } from 'h3'
import { sendFriendRequestSchema } from '../../utils/validation'
import { sendFriendRequest } from '../../services/socialService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = sendFriendRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return sendFriendRequest({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })
})
