import type { Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { adjustUserWallet, lockUserWallet } from './walletService'
import { dispatchUserTelegram } from './notificationService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'

export const adminUserSelect = { id: true, username: true, phone: true, role: true, blockedAt: true, deletedAt: true, createdAt: true, balance: true, wallet: { select: { balance: true } } } satisfies Prisma.UserSelect

export async function adminUserCommand(actorId: string, id: string, input: {
  action: 'credit' | 'debit' | 'set-balance' | 'block' | 'unblock' | 'revoke' | 'archive' | 'role'
  amount?: number; expectedBalance?: number; role?: 'USER' | 'ADMIN' | 'SUPERADMIN'; reason: string; requestId: string
}) {
  const result = await prisma.$transaction(async tx => {
    // Serializes role changes to protect the last superadmin and stale privileges.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-users', 0))::text`
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`
    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorId } })
    const target = await tx.user.findUnique({ where: { id } })
    if (!['ADMIN', 'SUPERADMIN'].includes(actor.role) || actor.blockedAt || actor.deletedAt) throw createError({ statusCode: 403, message: 'Права отозваны' })
    if (!target) throw createError({ statusCode: 404, message: 'Аккаунт не найден' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.actorId !== actorId || duplicate.entityId !== id || duplicate.action !== `user.${input.action}`) throw createError({ statusCode: 409, message: 'Ключ запроса уже занят' })
      return { success: true, duplicate: true }
    }
    const selfAction = actor.id === target.id
    if (actor.role !== 'SUPERADMIN' && (input.action === 'role' || (target.role !== 'USER' && !selfAction))) throw createError({ statusCode: 403, message: 'Нужны права владельца' })
    if (selfAction && ['block', 'revoke', 'archive', 'role'].includes(input.action)) throw createError({ statusCode: 403, message: 'Это действие нельзя применить к своему аккаунту' })
    if (target.deletedAt) throw createError({ statusCode: 409, message: 'Аккаунт находится в архиве' })
    if (target.role === 'SUPERADMIN' && ['block', 'archive', 'role'].includes(input.action)) {
      const count = await tx.user.count({ where: { role: 'SUPERADMIN', blockedAt: null, deletedAt: null } })
      if (count <= 1) throw createError({ statusCode: 409, message: 'Нельзя отключить последнего владельца' })
    }
    let details: Prisma.InputJsonValue = { previousRole: target.role }
    if (['credit', 'debit', 'set-balance'].includes(input.action)) {
      if (!Number.isSafeInteger(input.amount) || input.amount! < 0 || input.amount! > 2000000000 || !Number.isSafeInteger(input.expectedBalance)) throw createError({ statusCode: 400, message: 'Укажите целую сумму и подтвердите текущий баланс' })
      const wallet = await lockUserWallet(tx, id)
      if (wallet.balance !== BigInt(input.expectedBalance!)) throw createError({ statusCode: 409, message: 'Баланс изменился. Обновите предпросмотр' })
      const delta = input.action === 'set-balance' ? BigInt(input.amount!) - wallet.balance : BigInt(input.amount!) * (input.action === 'debit' ? -1n : 1n)
      if (wallet.balance + delta > 2000000000n) throw createError({ statusCode: 409, message: 'Превышен лимит кошелька' })
      if (delta !== 0n) await adjustUserWallet(tx, { userId: id, delta, entryType: 'ADMIN_ADJUSTMENT', idempotencyKey: `admin:${input.requestId}`, metadata: { actorId, reason: input.reason } })
      details = { before: wallet.balance.toString(), delta: delta.toString(), after: (wallet.balance + delta).toString() }
    } else if (input.action === 'archive') {
      const active = await tx.player.count({ where: { userId: id, OR: [{ participantId: { not: null } }, { balanceSettled: false, totalCommitted: { gt: 0 } }] } })
      const activeMines = await tx.miniGameSession.count({ where: { status: 'ACTIVE', OR: [{ userId: id }, { bankUserId: id }] } })
      if (active || activeMines) throw createError({ statusCode: 409, message: 'Сначала завершите участие и рассчитайте банки. Архив не удаляет права all-in' })
      await tx.user.update({ where: { id }, data: { deletedAt: new Date(), username: `deleted_${id}`, phone: null } })
      details = { previousUsername: target.username, retainedWallet: true }
    } else if (input.action === 'role') {
      if (!input.role || (input.role !== 'USER' && !target.phoneVerifiedAt)) throw createError({ statusCode: 409, message: 'Для администратора нужен подтверждённый телефон' })
      await tx.user.update({ where: { id }, data: { role: input.role } })
      details = { previousRole: target.role, nextRole: input.role }
    } else if (input.action === 'block' || input.action === 'unblock') await tx.user.update({ where: { id }, data: { blockedAt: input.action === 'block' ? new Date() : null } })
    if (['block', 'revoke', 'archive', 'role'].includes(input.action)) await tx.accountSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
    await tx.adminAudit.create({ data: { actorId, entityId: id, action: `user.${input.action}`, reason: input.reason, requestId: input.requestId, data: details } })
    return { success: true, duplicate: false, delta: details && typeof details === 'object' && 'delta' in details ? String((details as any).delta) : null }
  })
  if (!result.duplicate) {
    const action = input.action === 'credit' ? 'начислил' : input.action === 'debit' ? 'списал' : input.action === 'set-balance' ? 'изменил баланс' : `выполнил действие «${input.action}»`
    dispatchUserTelegram(id, 'adminChanges', `Администратор ${action} ваш аккаунт.`)
    void notifyAdminTelegram('users', `Admin action: ${action} для пользователя ${id}.`)
  }
  return result
}
