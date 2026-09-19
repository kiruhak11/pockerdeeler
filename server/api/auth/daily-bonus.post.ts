import { authTokenSchema } from '../../utils/validation'
import { claimDailyBonus } from '../../services/userAccountService'
export default defineEventHandler(async event => {
  const parsed = authTokenSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Необходим токен аккаунта' })
  return { user: await claimDailyBonus(parsed.data.token) }
})
