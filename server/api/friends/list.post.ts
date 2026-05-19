import { readBody } from 'h3'
import { authTokenSchema } from '../../utils/validation'
import { listFriends } from '../../services/socialService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = authTokenSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'token обязателен' })
  }

  return listFriends(parsed.data.token)
})
