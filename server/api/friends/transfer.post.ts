import { z } from 'zod'
import { createError, readBody } from 'h3'
import { transferToFriend } from '../../services/socialService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async event => {
  const parsed = z.object({ token: z.string().min(1), friendUserId: z.string().uuid(), amount: z.number().int().min(1).max(1_000_000), requestId: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Проверьте сумму и данные перевода' })
  return transferToFriend({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })
})
