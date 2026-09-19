import { createError, readBody } from 'h3'
import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { saveUserTelegramSettings, USER_TELEGRAM_CATEGORIES } from '../../services/notificationService'

const schema = z.object({ settings: z.record(z.boolean()) }).strict()
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success || Object.keys(parsed.data.settings).some(key => !(USER_TELEGRAM_CATEGORIES as readonly string[]).includes(key))) throw createError({ statusCode: 400, message: 'Некорректные категории уведомлений' })
  return { settings: await saveUserTelegramSettings(auth.userId, parsed.data.settings as any) }
})
