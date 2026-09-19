import { readBody } from 'h3'
import { respondRoomInviteSchema } from '../../utils/validation'
import { respondRoomInvite } from '../../services/socialService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = respondRoomInviteSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return respondRoomInvite({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })
})
