import { getHeader, readBody } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { doubleBlackjack } from '../../services/blackjackService'
import { blackjackActionSchema } from '../../utils/blackjackValidation'

export default defineEventHandler(async event => {
  const input = blackjackActionSchema.safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный запрос действия' })
  return doubleBlackjack(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, ''), input.data)
})
