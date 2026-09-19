import { createError } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { getUserTelegramSettings, USER_TELEGRAM_CATEGORIES } from '../../services/notificationService'

export default defineEventHandler(async event => {
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  return { categories: USER_TELEGRAM_CATEGORIES, settings: await getUserTelegramSettings(auth.userId) }
})
