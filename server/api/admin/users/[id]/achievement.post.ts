import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../../utils/adminAuth'
import { adminAchievementCommand } from '../../../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const parsed = z.object({ achievementId: z.string().uuid(), mode: z.enum(['grant', 'revoke']), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: 'Некорректное достижение' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminAchievementCommand(actor.id, id.data, parsed.data)
})
