import { getHeader, readBody } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { startBlackjack } from '../../services/blackjackService'
import { blackjackStartSchema } from '../../utils/blackjackValidation'

export default defineEventHandler(async event => {
  const input = blackjackStartSchema.safeParse(await readBody(event))
  if (!input.success) throw createError({ statusCode: 400, statusMessage: 'Ставка должна быть чётной и не меньше 2 фишек' })
  return startBlackjack(accountCookie(event) || getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, ''), input.data)
})
