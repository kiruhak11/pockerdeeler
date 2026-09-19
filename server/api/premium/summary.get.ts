import { createError } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { premiumSummary } from '../../services/premiumService'

export default defineEventHandler(async (event) => {
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
  return premiumSummary(auth.userId)
})
