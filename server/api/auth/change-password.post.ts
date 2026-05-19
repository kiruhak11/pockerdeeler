import { readBody } from 'h3'
import { changePasswordSchema } from '../../utils/validation'
import { changePassword } from '../../services/userAccountService'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = changePasswordSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  await changePassword(parsed.data)

  return {
    success: true
  }
})
