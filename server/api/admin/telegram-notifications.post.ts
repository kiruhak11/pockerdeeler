import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
import { adminTelegramSettingKey, normalizeAdminTelegramSettings, ADMIN_TELEGRAM_CATEGORIES } from '../../services/adminTelegramNotificationService'

const schema = z.object({
  enabled: z.boolean(),
  categories: z.record(z.boolean()),
  reason: z.string().trim().min(5).max(500),
  requestId: z.string().uuid(),
  password: z.string().max(128)
})

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event, true)
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректные настройки уведомлений' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  const after = normalizeAdminTelegramSettings({ enabled: parsed.data.enabled, categories: parsed.data.categories })
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-settings', 0))::text`
    if (await tx.adminAudit.findUnique({ where: { requestId: parsed.data.requestId } })) return
    const before = await tx.systemSetting.findUnique({ where: { key: adminTelegramSettingKey } })
    await tx.systemSetting.upsert({ where: { key: adminTelegramSettingKey }, create: { key: adminTelegramSettingKey, value: after }, update: { value: after } })
    await tx.adminAudit.create({ data: { actorId: actor.id, action: 'settings.telegram_notifications', entityId: adminTelegramSettingKey, requestId: parsed.data.requestId, reason: parsed.data.reason, data: { before: before?.value ?? null, after } } })
  })
  return { success: true, settings: after, categories: ADMIN_TELEGRAM_CATEGORIES }
})
