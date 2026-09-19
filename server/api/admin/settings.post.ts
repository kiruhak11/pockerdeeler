import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
export default defineEventHandler(async event => {
  const actor = await requireAdmin(event, true)
  const parsed = z.object({ enabled: z.boolean(), amount: z.number().int().min(1).max(100000), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректные настройки' })
  const { enabled, amount, reason, requestId, password } = parsed.data
  reauthenticate(password, actor.passwordHash)
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-settings', 0))::text`
    if (await tx.adminAudit.findUnique({ where: { requestId } })) return
    const before = await tx.systemSetting.findUnique({ where: { key: 'rewards' } })
    await tx.systemSetting.upsert({ where: { key: 'rewards' }, create: { key: 'rewards', value: { enabled, amount } }, update: { value: { enabled, amount } } })
    await tx.adminAudit.create({ data: { actorId: actor.id, action: 'settings.rewards', entityId: 'rewards', requestId, reason, data: { before: before?.value ?? null, after: { enabled, amount } } } })
  })
  return { success: true }
})
