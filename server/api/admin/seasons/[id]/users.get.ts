import { requireAdmin, jsonSafe } from '../../../../utils/adminAuth'
import { prisma } from '../../../../db/client'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const seasonId = getRouterParam(event, 'id') || ''
  const query = getQuery(event)
  const search = String(query.q || '').slice(0, 64)
  const items = await prisma.seasonalUserStats.findMany({ where: { seasonId, user: { username: { contains: search, mode: 'insensitive' } } }, orderBy: { balance: 'desc' }, take: 100, include: { user: { select: { id: true, username: true } } } })
  return jsonSafe(items)
})
