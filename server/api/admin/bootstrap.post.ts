import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { getUserByToken, verifyPassword } from '../../services/userAccountService'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { assertRateLimit } from '../../utils/rateLimit'
import { prisma } from '../../db/client'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  assertRateLimit(event, 'admin-bootstrap', { limit: 3, windowMs: 3600000 })
  const user = await getUserByToken(accountCookie(event))
  const parsed = z.object({ bootstrapPassword: z.string().max(256), password: z.string().min(12).max(128) }).safeParse(await readBody(event))
  const secret = process.env.ADMIN_BOOTSTRAP_PASSWORD || ''
  if (!parsed.success || secret.length < 20 || !user.phoneVerifiedAt || user.phone !== process.env.OWNER_PHONE) throw createError({ statusCode: 403, message: 'Первичная настройка недоступна для этого аккаунта' })
  const a = Buffer.from(secret), b = Buffer.from(parsed.data.bootstrapPassword)
  if (a.length !== b.length || !timingSafeEqual(a, b) || !verifyPassword(parsed.data.password, user.passwordHash)) throw createError({ statusCode: 403, message: 'Подтверждение не принято' })
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-users', 0))::text`
    if (await tx.systemSetting.findUnique({ where: { key: 'owner_bootstrapped' } })) throw createError({ statusCode: 409, message: 'Первичная настройка уже завершена' })
    await tx.user.update({ where: { id: user.id }, data: { role: 'SUPERADMIN', mustChangePassword: false } })
    await tx.systemSetting.create({ data: { key: 'owner_bootstrapped', value: { userId: user.id } } })
    await tx.adminAudit.create({ data: { actorId: user.id, entityId: user.id, action: 'owner.bootstrap', requestId: 'owner-bootstrap', reason: 'Verified allowlisted owner completed initial setup' } })
  })
  return { success: true }
})
