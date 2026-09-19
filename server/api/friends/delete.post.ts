import { readBody } from 'h3'
import { z } from 'zod'
import { deleteFriend } from '../../services/socialService'
import { resolveAccountToken } from '../../utils/accountCookie'

const schema = z.object({ token: z.string().min(16).or(z.literal('cookie-session')), friendshipId: z.string().uuid() }).strict()

export default defineEventHandler(async event => {
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная связь' })
  return deleteFriend({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })
})
