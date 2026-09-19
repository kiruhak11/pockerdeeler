import { readBody } from 'h3'
import { authTokenSchema } from '../../utils/validation'
import { listRoomInvites } from '../../services/socialService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = authTokenSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'token обязателен' })
  }

  return listRoomInvites(resolveAccountToken(event, parsed.data.token))
})
