import { requireAdmin, jsonSafe } from '../../utils/adminAuth'
import { prisma } from '../../db/client'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return jsonSafe(await prisma.achievement.findMany({ orderBy: [{ rarity: 'asc' }, { title: 'asc' }] }))
})
