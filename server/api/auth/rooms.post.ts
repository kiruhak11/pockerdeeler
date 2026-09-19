import { authTokenSchema } from '../../utils/validation'
import { getAccountRooms } from '../../services/gameService'

export default defineEventHandler(async event => {
  const parsed = authTokenSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Необходим токен аккаунта' })
  return getAccountRooms(parsed.data.token)
})
