import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../../utils/adminAuth'
import { adminProfileCommand } from '../../../../services/adminDataService'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  const parsed = z.object({ expectedUpdatedAt: z.string().datetime(), username: z.string().trim().min(2).max(64).optional(), phone: z.string().trim().max(16).nullable().optional(), role: z.enum(['USER', 'ADMIN', 'SUPERADMIN']).optional(), predictionRating: z.number().int().min(0).max(100000).optional(), tableRating: z.number().int().min(0).max(100000).optional(), tableHandsPlayed: z.number().int().min(0).max(100000000).optional(), tableHandsWon: z.number().int().min(0).max(100000000).optional(), tableCurrentStreak: z.number().int().min(0).max(1000000).optional(), tableBestStreak: z.number().int().min(0).max(1000000).optional(), predictionCount: z.number().int().min(0).max(100000000).optional(), predictionWins: z.number().int().min(0).max(100000000).optional(), predictionSplitWins: z.number().int().min(0).max(100000000).optional(), premiumType: z.string().trim().max(16).optional(), premiumUntil: z.string().datetime().nullable().optional(), selectedAchievementCode: z.string().trim().max(64).nullable().optional(), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), password: z.string().max(128) }).safeParse(await readBody(event))
  if (!id.success || !parsed.success) throw createError({ statusCode: 400, message: 'Некорректные данные профиля' })
  reauthenticate(parsed.data.password, actor.passwordHash)
  return adminProfileCommand(actor.id, id.data, parsed.data)
})
