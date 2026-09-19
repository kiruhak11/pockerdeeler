import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, Room } from '@prisma/client'
import { createError } from 'h3'

export const adminContext = new AsyncLocalStorage<{ actorId: string; roomHash: string; requestId: string; reason: string; command: string; revision: number }>()

export async function recordAdminRoomMutation(tx: Prisma.TransactionClient, room: Room) {
  const context = adminContext.getStore()
  if (!context) return
  if (context.roomHash !== room.dealerSecretHash) throw createError({ statusCode: 403, message: 'Команда относится к другой комнате' })
  const actor = await tx.user.findUnique({ where: { id: context.actorId } })
  if (!actor || actor.blockedAt || actor.deletedAt || !actor.phoneVerifiedAt || !['ADMIN', 'SUPERADMIN'].includes(actor.role)) throw createError({ statusCode: 403, message: 'Доступ администратора отозван' })
  const duplicate = await tx.adminAudit.findUnique({ where: { requestId: context.requestId } })
  if (duplicate) throw createError({ statusCode: 409, message: 'Команда уже выполнена. Обновите состояние' })
  if (room.revision !== context.revision) throw createError({ statusCode: 409, message: 'Состояние комнаты изменилось. Повторите предпросмотр' })
  // This audit commits or rolls back with the SAME poker transaction.
  await tx.adminAudit.create({ data: { actorId: context.actorId, entityId: room.id, requestId: context.requestId, reason: context.reason, action: `room.${context.command}`, data: { code: room.code, previousRevision: room.revision } } })
  await tx.auditLog.create({ data: { roomId: room.id, actorRole: 'system', eventType: 'admin.intervention', payload: { administratorId: context.actorId, reason: context.reason, command: context.command } } })
}
