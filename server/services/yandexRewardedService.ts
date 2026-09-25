import type { Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { getYandexSession } from './yandexIdentityService'
import { adjustUserWallet, lockUserWallet } from './walletService'

const ATTEMPT_TTL_MS = 3 * 60_000
const MAX_ACTIVE_ATTEMPTS_PER_USER = 2
export const YANDEX_REWARDED_VIEWS_PER_GRANT = 3
export const YANDEX_REWARDED_GRANT_AMOUNT = 10_000n
type Tx = Prisma.TransactionClient

// Yandex exposes the rewarded callback in the client SDK; this flow does not claim server-to-server impression attestation.
function requireBearerToken(token: string) {
  if (!token) throw createError({ statusCode: 401, message: 'Требуется Yandex session' })
}

async function requireEligibleUser(tx: Tx, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, accountOrigin: true, blockedAt: true, deletedAt: true } })
  if (!user || user.accountOrigin !== 'YANDEX_GAMES') throw createError({ statusCode: 403, message: 'Награда доступна только аккаунтам Яндекс Игр' })
  if (user.blockedAt || user.deletedAt) throw createError({ statusCode: 403, message: 'Аккаунт недоступен' })
  return user
}

async function authenticatedYandexUser(token: string) {
  requireBearerToken(token)
  const session = await getYandexSession(token)
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, accountOrigin: true, blockedAt: true, deletedAt: true } })
  if (!user || user.accountOrigin !== 'YANDEX_GAMES') throw createError({ statusCode: 403, message: 'Награда доступна только аккаунтам Яндекс Игр' })
  if (user.blockedAt || user.deletedAt) throw createError({ statusCode: 403, message: 'Аккаунт недоступен' })
  return user
}

async function progressFor(tx: Pick<Tx, 'yandexRewardedProgress'>, userId: string) {
  const progress = await tx.yandexRewardedProgress.findUnique({ where: { userId } })
  return { viewsSinceGrant: progress?.viewsSinceGrant ?? 0, completedGrants: progress?.completedGrants ?? 0 }
}

export async function getYandexRewardedState(token: string) {
  const user = await authenticatedYandexUser(token)
  const [progress, session] = await Promise.all([progressFor(prisma, user.id), getYandexSession(token)])
  return { ...progress, balance: session.user.balance }
}

export async function startYandexRewardedAttempt(token: string, requestId: string) {
  const user = await authenticatedYandexUser(token)
  const result = await prisma.$transaction(async tx => {
    await lockUserWallet(tx, user.id)
    await requireEligibleUser(tx, user.id)
    const now = new Date()
    const duplicate = await tx.yandexRewardedAdAttempt.findUnique({ where: { userId_requestId: { userId: user.id, requestId } } })
    if (duplicate) {
      if (duplicate.status === 'STARTED' && duplicate.expiresAt <= now) {
        await tx.yandexRewardedAdAttempt.update({ where: { id: duplicate.id }, data: { status: 'EXPIRED' } })
        return { expired: true as const }
      }
      return { attemptId: duplicate.id, status: duplicate.status, expiresAt: duplicate.expiresAt.toISOString(), ...await progressFor(tx, user.id) }
    }
    await tx.yandexRewardedAdAttempt.updateMany({ where: { userId: user.id, status: 'STARTED', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } })
    const activeAttempts = await tx.yandexRewardedAdAttempt.count({ where: { userId: user.id, status: 'STARTED', expiresAt: { gt: now } } })
    if (activeAttempts >= MAX_ACTIVE_ATTEMPTS_PER_USER) throw createError({ statusCode: 409, message: 'Уже начаты два просмотра. Завершите или закройте один из них.' })
    const attempt = await tx.yandexRewardedAdAttempt.create({ data: { userId: user.id, requestId, expiresAt: new Date(now.getTime() + ATTEMPT_TTL_MS) } })
    await tx.yandexRewardedProgress.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} })
    return { attemptId: attempt.id, status: attempt.status, expiresAt: attempt.expiresAt.toISOString(), ...await progressFor(tx, user.id) }
  })
  if ('expired' in result) throw createError({ statusCode: 409, message: 'Срок попытки истёк. Начните просмотр заново.' })
  return result
}

export async function completeYandexRewardedAttempt(token: string, attemptId: string) {
  const user = await authenticatedYandexUser(token)
  const result = await prisma.$transaction(async tx => {
    // The shared user-row lock serializes different attempts, preserving the fourth view across a grant boundary.
    const wallet = await lockUserWallet(tx, user.id)
    await requireEligibleUser(tx, user.id)
    const attempt = await tx.yandexRewardedAdAttempt.findUnique({ where: { id: attemptId } })
    if (!attempt || attempt.userId !== user.id) throw createError({ statusCode: 404, message: 'Попытка просмотра не найдена' })
    if (attempt.status === 'REWARDED') return { grantedAmount: attempt.grantedAmount, ...await progressFor(tx, user.id), balance: Number(wallet.balance) }
    if (attempt.status !== 'STARTED') throw createError({ statusCode: 409, message: 'Попытка просмотра уже закрыта' })
    if (attempt.expiresAt <= new Date()) {
      await tx.yandexRewardedAdAttempt.update({ where: { id: attempt.id }, data: { status: 'EXPIRED' } })
      return { expired: true as const }
    }

    const current = await tx.yandexRewardedProgress.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} })
    const rewardedAt = new Date()
    const nextViews = current.viewsSinceGrant + 1
    const grants = nextViews === YANDEX_REWARDED_VIEWS_PER_GRANT ? current.completedGrants + 1 : current.completedGrants
    let balance = wallet.balance
    if (nextViews === YANDEX_REWARDED_VIEWS_PER_GRANT) {
      if (balance + YANDEX_REWARDED_GRANT_AMOUNT > 2_000_000_000n) throw createError({ statusCode: 409, statusMessage: 'Достигнут лимит кошелька' })
      const updatedWallet = await adjustUserWallet(tx, {
        userId: user.id,
        delta: YANDEX_REWARDED_GRANT_AMOUNT,
        entryType: 'YANDEX_REWARDED_AD_REWARD',
        idempotencyKey: `yandex-rewarded:${user.id}:${grants}`,
        metadata: { provider: 'YANDEX_GAMES', rewardedViews: YANDEX_REWARDED_VIEWS_PER_GRANT, grantCycle: grants }
      })
      balance = updatedWallet.balance
    }
    const grantedAmount = nextViews === YANDEX_REWARDED_VIEWS_PER_GRANT ? Number(YANDEX_REWARDED_GRANT_AMOUNT) : 0
    await tx.yandexRewardedAdAttempt.update({ where: { id: attempt.id }, data: { status: 'REWARDED', rewardedAt, grantedAmount } })
    const nextProgress = await tx.yandexRewardedProgress.update({ where: { userId: user.id }, data: { viewsSinceGrant: nextViews === YANDEX_REWARDED_VIEWS_PER_GRANT ? 0 : nextViews, completedGrants: grants } })
    return { grantedAmount, viewsSinceGrant: nextProgress.viewsSinceGrant, completedGrants: nextProgress.completedGrants, balance: Number(balance) }
  })
  if ('expired' in result) throw createError({ statusCode: 409, message: 'Срок попытки истёк' })
  const session = await getYandexSession(token)
  return { ...result, user: session.user }
}

export async function cancelYandexRewardedAttempt(token: string, attemptId: string) {
  const user = await authenticatedYandexUser(token)
  return prisma.$transaction(async tx => {
    await lockUserWallet(tx, user.id)
    await requireEligibleUser(tx, user.id)
    const attempt = await tx.yandexRewardedAdAttempt.findUnique({ where: { id: attemptId } })
    if (!attempt || attempt.userId !== user.id) throw createError({ statusCode: 404, message: 'Попытка просмотра не найдена' })
    if (attempt.status === 'STARTED') {
      await tx.yandexRewardedAdAttempt.update({ where: { id: attempt.id }, data: { status: attempt.expiresAt <= new Date() ? 'EXPIRED' : 'CANCELLED' } })
    }
    return { status: attempt.status === 'STARTED' ? attempt.expiresAt <= new Date() ? 'EXPIRED' : 'CANCELLED' : attempt.status, ...await progressFor(tx, user.id) }
  })
}
