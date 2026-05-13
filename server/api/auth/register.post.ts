import { readBody } from 'h3'
import { registerSchema } from '../../utils/validation'
import { registerUser } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return registerUser(parsed.data)
})
