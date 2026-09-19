import { readBody } from 'h3'
import { updateUsernameSchema } from '../../utils/validation'
import { updateUsername } from '../../services/userAccountService'
import { resolveAccountToken } from '../../utils/accountCookie'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = updateUsernameSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректный payload' })
  }

  return {
    user: await updateUsername({ ...parsed.data, token: resolveAccountToken(event, parsed.data.token) })
  }
})
