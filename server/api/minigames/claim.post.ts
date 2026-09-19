import { z } from 'zod'
import { claimJackpot } from '../../services/jackpotService'
import { accountCookie } from '../../utils/accountCookie'
export default defineEventHandler(async event => {
  const input = z.object({ prizeId: z.string().uuid() }).safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная награда' })
  return claimJackpot(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer /i, ''), input.data.prizeId)
})
