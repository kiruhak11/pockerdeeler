import { createError, getQuery } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { currentLegalDocuments, legalAcceptanceContexts, type LegalAcceptanceContext } from '../../services/legalService'

export default defineEventHandler(async event => {
  const context = String(getQuery(event).context || '') as LegalAcceptanceContext
  if (!legalAcceptanceContexts.includes(context)) throw createError({ statusCode: 400, message: 'Неизвестный контекст согласия' })
  const token = accountCookie(event)
  const auth = token ? await verifyUserAuthToken(token) : null
  return { context, documents: await currentLegalDocuments(context, auth?.userId) }
})
