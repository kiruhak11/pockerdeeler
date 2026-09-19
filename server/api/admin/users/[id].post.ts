import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../utils/adminAuth'
import { adminUserCommand } from '../../../services/adminService'
import { assertRateLimit } from '../../../utils/rateLimit'
export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  assertRateLimit(event, 'admin-mutation', { subject: actor.id, limit: 20 })
  const parsed = z.object({ action: z.enum(['credit', 'debit', 'set-balance', 'block', 'unblock', 'revoke', 'archive', 'role']), amount: z.number().int().min(0).max(2000000000).optional(), expectedBalance: z.number().int().min(0).optional(), role: z.enum(['USER', 'ADMIN', 'SUPERADMIN']).optional(), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsed.success || !id.success) throw createError({ statusCode: 400, message: 'Проверьте сумму, причину и идентификатор' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminUserCommand(actor.id, id.data, parsed.data)
})
