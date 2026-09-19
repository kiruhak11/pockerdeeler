import { createError } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { telegramStatus } from '../../services/telegramService'
export default defineEventHandler(event => { const token = accountCookie(event); if (!token) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' }); return telegramStatus(token) })
