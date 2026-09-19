import { requireAdmin, jsonSafe } from '../../utils/adminAuth'
import { prisma } from '../../db/client'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const seasons = await prisma.season.findMany({ orderBy: { number: 'desc' }, take: 30, include: { _count: { select: { stats: true, rewards: true, leaderboards: true } } } })
  return jsonSafe(seasons)
})
