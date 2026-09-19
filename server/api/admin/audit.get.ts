import { requireAdmin } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const page = Math.max(0, Math.min(10000, Math.floor(Number(getQuery(event).page) || 0)))
  return { items: await prisma.adminAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 30, skip: page * 30 }), total: await prisma.adminAudit.count() }
})
