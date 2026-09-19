import { accountCookie, clearAccountCookie } from '../../utils/accountCookie'
import { sessionHash } from '../../services/userAccountService'
import { prisma } from '../../db/client'
export default defineEventHandler(async event => {
  const token = accountCookie(event)
  if (token) await prisma.accountSession.updateMany({ where: { tokenHash: sessionHash(token) }, data: { revokedAt: new Date() } })
  clearAccountCookie(event)
  return { success: true }
})
