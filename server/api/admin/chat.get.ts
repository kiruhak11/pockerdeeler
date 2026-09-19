import { z } from 'zod'
import { requireAdmin } from '../../utils/adminAuth'
import { assertRateLimit } from '../../utils/rateLimit'
import { prisma } from '../../db/client'

export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  setHeader(event, 'Cache-Control', 'no-store')
  assertRateLimit(event, 'admin-chat-read', { subject: actor.id, limit: 120 })
  const parsed = z.object({ q: z.string().trim().max(300).default(''), roomCode: z.string().trim().max(8).default(''), page: z.coerce.number().int().min(0).max(10000).default(0) }).safeParse(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректный поиск сообщений' })
  const { q, roomCode, page } = parsed.data
  const where = { ...(roomCode ? { room: { code: roomCode.toUpperCase() } } : {}), ...(q ? { OR: [{ text: { contains: q, mode: 'insensitive' as const } }, { senderName: { contains: q, mode: 'insensitive' as const } }] } : {}) }
  const [items, total] = await prisma.$transaction([
    prisma.roomChatMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30, skip: page * 30,
      select: { id: true, roomId: true, participantId: true, senderName: true, text: true, createdAt: true, deletedAt: true, deletionReason: true, room: { select: { code: true, name: true } } } }),
    prisma.roomChatMessage.count({ where })
  ])
  return { items, total, page }
})
