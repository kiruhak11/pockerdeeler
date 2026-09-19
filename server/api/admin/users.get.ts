import { requireAdmin, jsonSafe } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
import { adminUserSelect } from '../../services/adminService'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const query = getQuery(event), q = String(query.q || '').slice(0, 64)
  const page = Math.max(0, Math.min(10000, Math.floor(Number(query.page) || 0)))
  const where = { OR: [{ username: { contains: q, mode: 'insensitive' as const } }, { phone: { contains: q } }] }
  const items = await prisma.user.findMany({ where, select: adminUserSelect, take: 30, skip: page * 30, orderBy: { createdAt: 'desc' } })
  return jsonSafe({ items: items.map(({ wallet, ...user }) => ({ ...user, balance: wallet?.balance ?? user.balance })), total: await prisma.user.count({ where }) })
})
