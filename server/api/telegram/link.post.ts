import { readBody, createError } from 'h3'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { createTelegramLink } from '../../services/telegramService'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const token = accountCookie(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return createTelegramLink(token)
})
