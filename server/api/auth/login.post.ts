import { readBody } from 'h3'
import { loginSchema } from '../../utils/validation'
import { loginUser } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return loginUser(parsed.data)
})
