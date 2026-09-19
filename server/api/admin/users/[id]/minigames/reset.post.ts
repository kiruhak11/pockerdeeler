import { createError } from 'h3'
import { z } from 'zod'
import { requireAdmin, reauthenticate, jsonSafe } from '../../../../../utils/adminAuth'
import { adminMiniGameResetCommand } from '../../../../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const parsed = z.object({ reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: 'Укажите причину и идентификатор пользователя' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return jsonSafe(await adminMiniGameResetCommand(actor.id, id.data, parsed.data))
})
