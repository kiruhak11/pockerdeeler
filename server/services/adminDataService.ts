import type { Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { notifyAchievementAward } from './achievementService'
import { premiumExpiresAt } from './premiumService'
import { dispatchUserTelegram } from './notificationService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'

const adminUserDetailSelect = {
  id: true, username: true, phone: true, phoneVerifiedAt: true, role: true,
  blockedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
  balance: true, predictionRating: true, tableRating: true, tableHandsPlayed: true,
  tableHandsWon: true, tableCurrentStreak: true, tableBestStreak: true,
  predictionCount: true, predictionWins: true, predictionSplitWins: true,
  premiumType: true, premiumUntil: true, selectedAchievementCode: true,
  wallet: { select: { balance: true, updatedAt: true } },
  premiumSubscriptions: { orderBy: [{ expiresAt: 'desc' as const }, { createdAt: 'desc' as const }], take: 10 },
  achievements: { orderBy: { unlockedAt: 'desc' as const }, include: { achievement: true } },
  seasonalStats: { orderBy: { updatedAt: 'desc' as const }, take: 20, include: { season: { select: { id: true, number: true, status: true, startsAt: true, endsAt: true } } } },
  _count: { select: { miniGameSessions: true, crashBets: true, rewardSessions: true } }
} satisfies Prisma.UserSelect

export async function adminUserDetail(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: adminUserDetailSelect })
  if (!user) throw createError({ statusCode: 404, message: 'Аккаунт не найден' })
  const now = Date.now()
  const activePremium = user.premiumSubscriptions.find(item => item.status === 'ACTIVE' && item.startedAt.getTime() <= now && item.expiresAt.getTime() > now)
  const { premiumSubscriptions: _premiumSubscriptions, ...publicUser } = user
  return {
    ...publicUser,
    balance: user.wallet?.balance ?? user.balance,
    premium: activePremium ? { active: true, plan: activePremium.plan, startedAt: activePremium.startedAt, expiresAt: activePremium.expiresAt } : { active: false, plan: null, startedAt: null, expiresAt: null }
  }
}

type AuditInput = { actorId: string; entityId: string; action: string; reason: string; requestId: string; data: Prisma.InputJsonValue }

async function createAdminAudit(tx: Prisma.TransactionClient, input: AuditInput) {
  const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
  if (duplicate) return true
  await tx.adminAudit.create({ data: input })
  return false
}

export async function adminProfileCommand(actorId: string, id: string, input: {
  expectedUpdatedAt: string; username?: string; phone?: string | null; role?: 'USER' | 'ADMIN' | 'SUPERADMIN';
  predictionRating?: number; tableRating?: number; tableHandsPlayed?: number; tableHandsWon?: number;
  tableCurrentStreak?: number; tableBestStreak?: number; predictionCount?: number; predictionWins?: number;
  predictionSplitWins?: number; premiumType?: string; premiumUntil?: string | null; selectedAchievementCode?: string | null;
  reason: string; requestId: string
}) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-users', 0))::text`
    await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`
    const [actor, target] = await Promise.all([tx.user.findUniqueOrThrow({ where: { id: actorId } }), tx.user.findUnique({ where: { id } })])
    if (!target) throw createError({ statusCode: 404, message: 'Аккаунт не найден' })
    if (!['ADMIN', 'SUPERADMIN'].includes(actor.role) || actor.blockedAt || actor.deletedAt) throw createError({ statusCode: 403, message: 'Права отозваны' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.actorId !== actorId || duplicate.entityId !== id || duplicate.action !== 'user.profile') throw createError({ statusCode: 409, message: 'Ключ запроса уже занят' })
      return { success: true, duplicate: true, updatedAt: target.updatedAt }
    }
    if (actor.role !== 'SUPERADMIN' && target.role !== 'USER' && actor.id !== target.id) throw createError({ statusCode: 403, message: 'Нужны права владельца' })
    if (target.deletedAt) throw createError({ statusCode: 409, message: 'Аккаунт находится в архиве' })
    if (target.role === 'SUPERADMIN' && input.role && input.role !== 'SUPERADMIN') {
      if (await tx.user.count({ where: { role: 'SUPERADMIN', blockedAt: null, deletedAt: null } }) <= 1) throw createError({ statusCode: 409, message: 'Нельзя отключить последнего владельца' })
    }
    if (new Date(input.expectedUpdatedAt).getTime() !== target.updatedAt.getTime()) throw createError({ statusCode: 409, message: 'Данные изменились. Обновите карточку' })
    if (input.role && actor.role !== 'SUPERADMIN' && input.role !== target.role) throw createError({ statusCode: 403, message: 'Менять роли может только владелец' })
    if (input.role && input.role !== 'USER' && !target.phoneVerifiedAt) throw createError({ statusCode: 409, message: 'Для администратора нужен подтверждённый телефон' })
    const data: Prisma.UserUpdateInput = {}
    if (input.username !== undefined) data.username = input.username.trim().slice(0, 64)
    if (input.phone !== undefined) data.phone = input.phone?.trim() || null
    if (input.role !== undefined) data.role = input.role
    for (const key of ['predictionRating', 'tableRating', 'tableHandsPlayed', 'tableHandsWon', 'tableCurrentStreak', 'tableBestStreak', 'predictionCount', 'predictionWins', 'predictionSplitWins'] as const) {
      if (input[key] !== undefined) data[key] = input[key]
    }
    if (input.premiumType !== undefined) data.premiumType = input.premiumType.trim().slice(0, 16)
    if (input.premiumUntil !== undefined) data.premiumUntil = input.premiumUntil ? new Date(input.premiumUntil) : null
    if (input.selectedAchievementCode !== undefined) data.selectedAchievementCode = input.selectedAchievementCode
    if (!Object.keys(data).length) throw createError({ statusCode: 400, message: 'Нет изменений' })
    const before = { username: target.username, role: target.role, predictionRating: target.predictionRating, tableRating: target.tableRating, tableHandsPlayed: target.tableHandsPlayed, tableHandsWon: target.tableHandsWon, predictionCount: target.predictionCount, predictionWins: target.predictionWins, premiumType: target.premiumType, premiumUntil: target.premiumUntil, selectedAchievementCode: target.selectedAchievementCode }
    const updated = await tx.user.update({ where: { id }, data })
    const duplicateAudit = await createAdminAudit(tx, { actorId, entityId: id, action: 'user.profile', reason: input.reason, requestId: input.requestId, data: { before, after: data } as Prisma.InputJsonValue })
    return { success: true, duplicate: duplicateAudit, updatedAt: updated.updatedAt }
  })
  if (!result.duplicate) {
    dispatchUserTelegram(id, 'adminChanges', 'Администратор изменил данные вашего аккаунта.')
    void notifyAdminTelegram('users', `Admin profile action для пользователя ${id}.`)
  }
  return result
}

export async function adminPremiumCommand(actorId: string, id: string, input: {
  action: 'assign' | 'extend' | 'disable'
  plan?: 'LITE' | 'PRO' | 'ELITE'
  reason: string
  requestId: string
}) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-users', 0))::text`
    await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`
    const [actor, target] = await Promise.all([tx.user.findUniqueOrThrow({ where: { id: actorId } }), tx.user.findUnique({ where: { id } })])
    if (!target) throw createError({ statusCode: 404, message: 'Аккаунт не найден' })
    if (!['ADMIN', 'SUPERADMIN'].includes(actor.role) || actor.blockedAt || actor.deletedAt) throw createError({ statusCode: 403, message: 'Права отозваны' })
    if (actor.role !== 'SUPERADMIN' && target.role !== 'USER' && actor.id !== target.id) throw createError({ statusCode: 403, message: 'Нужны права владельца' })
    if (target.deletedAt) throw createError({ statusCode: 409, message: 'Аккаунт находится в архиве' })

    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.actorId !== actorId || duplicate.entityId !== id || duplicate.action !== `user.premium.${input.action}`) throw createError({ statusCode: 409, message: 'Ключ запроса уже занят' })
      return { success: true, duplicate: true }
    }

    const now = new Date()
    const current = await tx.premiumSubscription.findFirst({ where: { userId: id, status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } })
    const before = current ? { plan: current.plan, expiresAt: current.expiresAt.toISOString() } : null
    let after: { plan: string; expiresAt: string } | null = null

    if (input.action === 'assign') {
      if (!input.plan) throw createError({ statusCode: 400, message: 'Выберите тариф Premium' })
      await tx.premiumSubscription.updateMany({ where: { userId: id, status: 'ACTIVE' }, data: { status: 'CANCELLED' } })
      const created = await tx.premiumSubscription.create({ data: { userId: id, plan: input.plan, startedAt: now, expiresAt: premiumExpiresAt(now), status: 'ACTIVE' } })
      after = { plan: created.plan, expiresAt: created.expiresAt.toISOString() }
    } else if (input.action === 'extend') {
      if (!current) throw createError({ statusCode: 409, message: 'У пользователя нет активного Premium' })
      const base = current.expiresAt.getTime() > now.getTime() ? current.expiresAt : now
      const updated = await tx.premiumSubscription.update({ where: { id: current.id }, data: { expiresAt: premiumExpiresAt(base) } })
      after = { plan: updated.plan, expiresAt: updated.expiresAt.toISOString() }
    } else {
      if (!current) throw createError({ statusCode: 409, message: 'У пользователя нет активного Premium' })
      await tx.premiumSubscription.updateMany({ where: { userId: id, status: 'ACTIVE' }, data: { status: 'CANCELLED' } })
    }

    await createAdminAudit(tx, { actorId, entityId: id, action: `user.premium.${input.action}`, reason: input.reason, requestId: input.requestId, data: { before, after } })
    return { success: true, duplicate: false, premium: after }
  })
  if (!result.duplicate) {
    const label = input.action === 'disable' ? 'Premium отключён' : `Premium ${result.premium?.plan || input.plan} изменён`
    dispatchUserTelegram(id, 'premium', label)
    dispatchUserTelegram(id, 'adminChanges', `Администратор: ${label}.`)
    void notifyAdminTelegram('premium', `Admin Premium action: ${label}, user ${id}.`)
  }
  return result
}

export async function adminAchievementCommand(actorId: string, id: string, input: { achievementId: string; mode: 'grant' | 'revoke'; reason: string; requestId: string }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`
    const target = await tx.user.findUnique({ where: { id } })
    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorId } })
    if (!['ADMIN', 'SUPERADMIN'].includes(actor.role) || actor.blockedAt || actor.deletedAt || (actor.role !== 'SUPERADMIN' && target?.role !== 'USER' && actor.id !== target?.id)) throw createError({ statusCode: 403, message: 'Недостаточно прав' })
    const achievement = await tx.achievement.findUnique({ where: { id: input.achievementId } })
    if (!target || !achievement) throw createError({ statusCode: 404, message: 'Пользователь или достижение не найдено' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.actorId !== actorId || duplicate.entityId !== id || duplicate.action !== `user.achievement.${input.mode}`) throw createError({ statusCode: 409, message: 'Ключ запроса уже занят' })
      return { success: true, duplicate: true }
    }
    let details: Prisma.InputJsonValue
    if (input.mode === 'grant') {
      const existing = await tx.userAchievement.findUnique({ where: { userId_achievementId: { userId: id, achievementId: input.achievementId } } })
      if (!existing) {
        await tx.userAchievement.create({ data: { userId: id, achievementId: input.achievementId, progress: 100 } })
        await notifyAchievementAward(tx, id, achievement)
      } else {
        await tx.userAchievement.update({ where: { id: existing.id }, data: { progress: 100 } })
      }
      details = { achievement: achievement.code, mode: input.mode }
    } else {
      await tx.userAchievement.deleteMany({ where: { userId: id, achievementId: input.achievementId } })
      details = { achievement: achievement.code, mode: input.mode }
    }
    const duplicateAudit = await createAdminAudit(tx, { actorId, entityId: id, action: `user.achievement.${input.mode}`, reason: input.reason, requestId: input.requestId, data: details })
    return { success: true, duplicate: duplicateAudit }
  })
}

export async function adminMiniGameResetCommand(actorId: string, id: string, input: { reason: string; requestId: string }) {
  return prisma.$transaction(async tx => {
    // Match the games' lock order: season/start, rocket, mine session, then wallet/user.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(928374)`
    await tx.$queryRaw`SELECT id FROM mini_game_sessions WHERE user_id=${id}::uuid ORDER BY id FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM users WHERE id=${id}::uuid FOR UPDATE`
    const [actor, target] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: actorId } }),
      tx.user.findUnique({ where: { id } })
    ])
    if (!target) throw createError({ statusCode: 404, message: 'Аккаунт не найден' })
    if (!['ADMIN', 'SUPERADMIN'].includes(actor.role) || actor.blockedAt || actor.deletedAt) throw createError({ statusCode: 403, message: 'Права отозваны' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.actorId !== actorId || duplicate.entityId !== id || duplicate.action !== 'user.minigames.reset') throw createError({ statusCode: 409, message: 'Ключ запроса уже занят' })
      return { success: true, duplicate: true }
    }
    if (actor.role !== 'SUPERADMIN' && target.role !== 'USER' && actor.id !== target.id) throw createError({ statusCode: 403, message: 'Нужны права владельца' })
    if (target.deletedAt) throw createError({ statusCode: 409, message: 'Аккаунт находится в архиве' })
    // Deleting a bet during betting would let the same user place a free second
    // bet: the financial ledger deliberately retains the original stake key.
    if (await tx.crashBet.count({ where: { userId: id, round: { phase: { in: ['betting', 'flying'] } } } })) throw createError({ statusCode: 409, message: 'Дождитесь завершения текущего раунда ракетки' })
    if (await tx.miniGameSession.count({ where: { userId: id, status: 'ACTIVE', bankReserve: { gt: 0 } } })) throw createError({ statusCode: 409, message: 'Сначала завершите игру с зарезервированным банком' })
    const now = new Date()
    const activeMines = await tx.miniGameSession.count({ where: { userId: id, status: 'ACTIVE' } })
    const activeRocket = await tx.crashBet.count({ where: { userId: id, cashedAt: null, round: { phase: { in: ['betting', 'flying'] } } } })
    const [deletedMines, deletedRocket] = await Promise.all([
      tx.miniGameSession.deleteMany({ where: { userId: id } }),
      tx.crashBet.deleteMany({ where: { userId: id } })
    ])
    await tx.minesCommitment.deleteMany({ where: { userId: id } })
    await tx.user.update({ where: { id }, data: { miniGameResetAt: now } })
    await tx.adminAudit.create({
      data: {
        actorId,
        entityId: id,
        action: 'user.minigames.reset',
        reason: input.reason,
        requestId: input.requestId,
        data: { deletedMines: deletedMines.count, deletedRocket: deletedRocket.count, activeMines, activeRocket, balanceUnchanged: true }
      }
    })
    return { success: true, duplicate: false, deletedMines: deletedMines.count, deletedRocket: deletedRocket.count }
  })
}

export async function adminSeasonStatsCommand(actorId: string, input: { id: string; expectedUpdatedAt: string; fields: Record<string, number | boolean>; reason: string; requestId: string }) {
  return prisma.$transaction(async tx => {
    const current = await tx.seasonalUserStats.findUnique({ where: { id: input.id } })
    if (!current) throw createError({ statusCode: 404, message: 'Сезонная статистика не найдена' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) return { success: true, duplicate: true, updatedAt: current.updatedAt }
    if (new Date(input.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()) throw createError({ statusCode: 409, message: 'Сезонная статистика изменилась' })
    const allowed = ['balance', 'startingBalance', 'tableRating', 'predictionRating', 'handsPlayed', 'handsWon', 'predictionCount', 'predictionWins', 'predictionSplitWins', 'totalPredictionProfit', 'totalWon', 'totalLost', 'bestWinStreak', 'currentWinStreak', 'activeDays', 'roomsJoined', 'excluded'] as const
    const data: Record<string, number | boolean | bigint> = {}
    for (const key of allowed) if (input.fields[key] !== undefined) data[key] = ['balance', 'startingBalance', 'totalPredictionProfit', 'totalWon', 'totalLost'].includes(key) ? BigInt(Number(input.fields[key])) : input.fields[key]
    if (!Object.keys(data).length) throw createError({ statusCode: 400, message: 'Нет изменений' })
    const updated = await tx.seasonalUserStats.update({ where: { id: input.id }, data })
    const duplicateAudit = await createAdminAudit(tx, { actorId, entityId: current.userId, action: 'season.user-stats', reason: input.reason, requestId: input.requestId, data: { statsId: input.id, fields: input.fields } as Prisma.InputJsonValue })
    return { success: true, duplicate: duplicateAudit, updatedAt: updated.updatedAt }
  })
}

export async function adminEconomyCommand(actorId: string, input: { minesBank: number; rocketBank: number; jackpotTenths: number; expectedUpdatedAt: string; reason: string; requestId: string }) {
  return prisma.$transaction(async tx => {
    const current = await tx.miniGameEconomy.findUnique({ where: { id: 'global' } })
    if (!current) throw createError({ statusCode: 404, message: 'Экономика мини-игр ещё не создана' })
    const duplicate = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) return { success: true, duplicate: true, updatedAt: current.updatedAt }
    if (current.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw createError({ statusCode: 409, message: 'Банк уже изменился. Обновите страницу' })
    const after = { minesBank: BigInt(input.minesBank), rocketBank: BigInt(input.rocketBank), jackpotTenths: BigInt(input.jackpotTenths) }
    const updated = await tx.miniGameEconomy.update({ where: { id: 'global' }, data: { minesBank: after.minesBank, rocketBank: after.rocketBank, jackpotTenths: after.jackpotTenths, jackpot: after.jackpotTenths / 10n, updatedAt: new Date() } })
    const duplicateAudit = await createAdminAudit(tx, { actorId, entityId: 'global', action: 'economy.update', reason: input.reason, requestId: input.requestId, data: { before: { minesBank: current.minesBank.toString(), rocketBank: current.rocketBank.toString(), jackpotTenths: current.jackpotTenths.toString() }, after: { minesBank: input.minesBank, rocketBank: input.rocketBank, jackpotTenths: input.jackpotTenths } } })
    return { success: true, duplicate: duplicateAudit, updatedAt: updated.updatedAt }
  })
}
