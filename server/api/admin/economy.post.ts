import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../utils/adminAuth'
import { adminEconomyCommand } from '../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event, true)
  const parsed = z.object({ minesBank: z.number().int().min(0).max(2_000_000_000), rocketBank: z.number().int().min(0).max(2_000_000_000), jackpotTenths: z.number().int().min(0).max(20_000_000_000), expectedUpdatedAt: z.string().datetime(), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректные значения банка' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminEconomyCommand(actor.id, parsed.data)
})
