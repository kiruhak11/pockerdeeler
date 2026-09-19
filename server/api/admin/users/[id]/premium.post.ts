import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../../utils/adminAuth'
import { adminPremiumCommand } from '../../../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const parsed = z.object({
    action: z.enum(['assign', 'extend', 'disable']),
    plan: z.enum(['LITE', 'PRO', 'ELITE']).optional(),
    reason: z.string().trim().min(5).max(500),
    requestId: z.string().uuid(),
    password: z.string().max(128)
  }).strict().safeParse(await readBody(event))
  if (!id.success || !parsed.success || (parsed.data.action === 'assign' && !parsed.data.plan)) throw createError({ statusCode: 400, message: 'Некорректные данные Premium' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminPremiumCommand(actor.id, id.data, parsed.data)
})
