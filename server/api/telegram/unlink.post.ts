import { createError } from 'h3'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { unlinkTelegram } from '../../services/telegramService'

export default defineEventHandler(event => {
  assertSameOrigin(event)
  const token = accountCookie(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return unlinkTelegram(token)
})
