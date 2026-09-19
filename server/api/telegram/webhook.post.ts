import { getHeader, readBody, createError } from 'h3'
import { handleTelegramUpdate } from '../../services/telegramService'
export default defineEventHandler(async event => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (secret && getHeader(event, 'x-telegram-bot-api-secret-token') !== secret) throw createError({ statusCode: 401, statusMessage: 'Invalid webhook secret' })
  return handleTelegramUpdate(await readBody(event))
})
