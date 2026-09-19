import { readBody } from 'h3'
import { changePasswordSchema } from '../../utils/validation'
import { changePassword } from '../../services/userAccountService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = changePasswordSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  await changePassword({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })

  return {
    success: true
  }
})
