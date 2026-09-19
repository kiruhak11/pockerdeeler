import type { Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { getUserByToken, getUserProfile } from './userAccountService'
import { adjustUserWallet, lockUserWallet } from './walletService'
import { getPremiumAccess } from './premiumService'

type Tx = Prisma.TransactionClient
const DAY = 86_400_000
export const BASE_REWARD_AMOUNT = 10_000
export const ELITE_REWARD_AMOUNT = 15_000

export function rewardAmountForPlan(plan: string | null, configuredAmount: number) {
  void configuredAmount
  return plan === 'ELITE' ? ELITE_REWARD_AMOUNT : BASE_REWARD_AMOUNT
}

export async function rewardSettings(tx: Pick<Tx, 'systemSetting'> = prisma) {
  const saved = await tx.systemSetting.findUnique({ where: { key: 'rewards' } })
  const config = saved?.value as { enabled?: boolean } | null
  // The base amount is a server-side product rule. Configuration/client input
  // must never be able to turn it into an arbitrary grant.
  return { enabled: config?.enabled ?? process.env.SELF_PROMO_REWARD_ENABLED !== 'false', amount: BASE_REWARD_AMOUNT, seconds: 10 as const }
}

async function eligibility(tx: Tx, userId: string) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
  const busy = await tx.player.findFirst({ where: { userId, OR: [
    { participantId: { not: null }, room: { status: { in: ['active', 'paused'] } } },
    { balanceSettled: false, totalCommitted: { gt: 0 } }
  ] } })
  const next = user.lastDailyBonusAt ? new Date(user.lastDailyBonusAt.getTime() + DAY) : null
  const reason = user.deletedAt || user.blockedAt ? 'Аккаунт недоступен'
    : !user.phoneVerifiedAt ? 'Сначала подтвердите телефон'
      : busy ? 'Выйдите из игры и дождитесь расчёта раздачи'
        : next && next.getTime() > Date.now() ? 'Следующий бонус доступен через 24 часа после предыдущего' : undefined
  return { reason, nextAvailableAt: next?.toISOString() ?? null }
}

async function locked<T>(userId: string, work: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async tx => {
    // Same order as gameplay: rooms, user, wallet. Join also locks the user, so
    // the eligibility recheck cannot race a buy-in after these locks are held.
    const players = await tx.player.findMany({ where: { userId, participantId: { not: null } }, select: { roomId: true } })
    for (const id of [...new Set(players.map(p => p.roomId))].sort()) await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id}::uuid FOR UPDATE`
    await lockUserWallet(tx, userId)
    await tx.rewardSession.updateMany({ where: { userId, status: 'watching', expiresAt: { lte: new Date() } }, data: { status: 'expired' } })
    return work(tx)
  })
}

async function state(tx: Tx, userId: string) {
  const settings = await rewardSettings(tx), eligible = await eligibility(tx, userId), premium = await getPremiumAccess(userId, tx)
  const elite = premium.active && premium.plan === 'ELITE'
  const attempt = await tx.rewardSession.findFirst({ where: { userId, status: 'watching', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
  return { ...settings, amount: rewardAmountForPlan(elite ? 'ELITE' : null, settings.amount), elite, requiresViewing: !elite, ...eligible, available: settings.enabled && !eligible.reason,
    reason: settings.enabled ? eligible.reason : 'Бонусы временно отключены',
    attempt: attempt ? { id: attempt.id, status: attempt.status, readyAt: attempt.readyAt.toISOString(), expiresAt: attempt.expiresAt.toISOString(), amount: attempt.amount } : null,
    eliteAttempt: Boolean(elite && attempt?.amount === ELITE_REWARD_AMOUNT) }
}

export async function getRewardState(token: string) {
  const user = await getUserByToken(token)
  return prisma.$transaction(tx => state(tx, user.id))
}

export async function startReward(token: string, requestId: string) {
  const user = await getUserByToken(token)
  return locked(user.id, async tx => {
    const duplicate = await tx.rewardSession.findUnique({ where: { requestId } })
    if (duplicate) {
      if (duplicate.userId !== user.id) throw createError({ statusCode: 409, message: 'Идентификатор попытки уже используется' })
      return state(tx, user.id)
    }
    const current = await state(tx, user.id)
    if (!current.available) throw createError({ statusCode: 409, message: current.reason })
    if (!current.attempt) await tx.rewardSession.create({ data: { userId: user.id, requestId, amount: current.amount, provider: current.elite ? 'elite_promo' : 'self_promo', readyAt: new Date(Date.now() + (current.requiresViewing ? 10000 : 0)), expiresAt: new Date(Date.now() + 300000) } })
    return state(tx, user.id)
  })
}

export async function completeReward(token: string, id: string) {
  const user = await getUserByToken(token)
  await locked(user.id, async tx => {
    const attempt = await tx.rewardSession.findUnique({ where: { id } })
    if (!attempt || attempt.userId !== user.id) throw createError({ statusCode: 404, message: 'Попытка не найдена' })
    if (attempt.status === 'completed') return
    const current = await state(tx, user.id)
    if (!current.available) throw createError({ statusCode: 409, message: current.reason })
    if (attempt.provider === 'elite_promo' && !current.eliteAttempt) {
      throw createError({ statusCode: 409, message: 'Premium Elite больше не активен для этой попытки' })
    }
    if (attempt.status !== 'watching' || attempt.expiresAt.getTime() <= Date.now() || attempt.readyAt.getTime() > Date.now()) throw createError({ statusCode: 409, message: 'Просмотр не завершён или время попытки истекло' })
    const wallet = await lockUserWallet(tx, user.id)
    if (wallet.balance + BigInt(attempt.amount) > 2000000000n) throw createError({ statusCode: 409, message: 'Достигнут лимит кошелька' })
    // This first-party timer is NOT external ad-view attestation. The server
    // enforces duration, ownership, cooldown and a unique ledger grant only.
    await adjustUserWallet(tx, { userId: user.id, delta: BigInt(attempt.amount), entryType: 'SELF_PROMO_REWARD', idempotencyKey: `reward:${id}`, metadata: { provider: attempt.provider, attemptId: id, seconds: 10 } })
    await tx.user.update({ where: { id: user.id }, data: { lastDailyBonusAt: new Date() } })
    await tx.rewardSession.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } })
  })
  return { user: await getUserProfile(token), state: await getRewardState(token) }
}

export async function cancelReward(token: string, id: string) {
  const user = await getUserByToken(token)
  return locked(user.id, async tx => {
    await tx.rewardSession.updateMany({ where: { id, userId: user.id, status: 'watching' }, data: { status: 'cancelled' } })
    return state(tx, user.id)
  })
}
