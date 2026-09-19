import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../utils/adminAuth'
import { adminSeasonStatsCommand } from '../../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const parsed = z.object({ expectedUpdatedAt: z.string().datetime(), fields: z.record(z.union([z.number().int(), z.boolean()])).refine(value => Object.keys(value).length <= 20), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: 'Некорректная сезонная статистика' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminSeasonStatsCommand(actor.id, { id: id.data, ...parsed.data })
})
