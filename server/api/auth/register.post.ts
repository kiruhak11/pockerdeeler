import { isolatedAuthTests } from '../../utils/accountCookie'
import { readBody } from 'h3'
import { registerSchema } from '../../utils/validation'
import { registerUser } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  if (!isolatedAuthTests()) throw createError({ statusCode: 410, message: 'Регистрация доступна только после подтверждения телефона' })
  const body = await readBody(event)
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return registerUser(parsed.data)
})
