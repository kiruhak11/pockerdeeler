import { requireAdmin } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const rooms = await prisma.room.findMany({ take: 100, orderBy: { updatedAt: 'desc' }, select: { id: true, code: true, name: true, status: true, revision: true, _count: { select: { players: { where: { participantId: { not: null } } } } } } })
  return { items: rooms.map(({ _count, ...room }) => ({ ...room, playersCount: _count.players })) }
})
