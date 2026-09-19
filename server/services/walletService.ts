import { randomUUID } from 'node:crypto'
import type { Prisma, UserWallet } from '@prisma/client'
import { createError } from 'h3'
import { toChipNumber } from '../utils/chips'
import { prisma } from '../db/client'

type Tx = Prisma.TransactionClient

export async function ensureUserWallet(tx: Tx, userId: string): Promise<UserWallet> {
  const existing = await tx.userWallet.findUnique({ where: { userId } })
  if (existing) return existing

  const user = await tx.user.findUnique({ where: { id: userId }, select: { balance: true } })
  if (!user) throw createError({ statusCode: 404, statusMessage: 'Аккаунт не найден' })

  const wallet = await tx.userWallet.create({
    data: { userId, balance: BigInt(Math.max(0, user.balance)) }
  })
  if (wallet.balance > 0n) {
    await tx.walletLedgerEntry.create({
      data: {
        walletId: wallet.id,
        transferId: randomUUID(),
        entryType: 'OPENING_BALANCE',
        amount: wallet.balance,
        balanceAfter: wallet.balance,
        idempotencyKey: `wallet-opening:${userId}`,
        metadata: { source: 'users.balance', lazyMigration: true }
      }
    })
  }
  return wallet
}

export async function lockUserWallet(tx: Tx, userId: string): Promise<UserWallet> {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = CAST(${userId} AS uuid) FOR UPDATE`
  const wallet = await ensureUserWallet(tx, userId)
  await tx.$queryRaw`SELECT id FROM "user_wallets" WHERE id = CAST(${wallet.id} AS uuid) FOR UPDATE`
  return tx.userWallet.findUniqueOrThrow({ where: { id: wallet.id } })
}

export async function adjustUserWallet(tx: Tx, input: {
  userId: string
  delta: bigint
  entryType: string
  idempotencyKey: string
  transferId?: string
  roomId?: string
  memberId?: string
  metadata?: Prisma.InputJsonValue
}): Promise<UserWallet> {
  if (input.delta === 0n) throw createError({ statusCode: 400, statusMessage: 'Нулевое перемещение фишек запрещено' })

  const duplicate = await tx.walletLedgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (duplicate) return tx.userWallet.findUniqueOrThrow({ where: { id: duplicate.walletId } })

  const wallet = await lockUserWallet(tx, input.userId)
  const nextBalance = wallet.balance + input.delta
  if (nextBalance < 0n) throw createError({ statusCode: 409, statusMessage: 'В кошельке недостаточно свободных фишек' })

  const updated = await tx.userWallet.update({
    where: { id: wallet.id },
    data: { balance: nextBalance, version: { increment: 1 }, updatedAt: new Date() }
  })

  await tx.user.update({
    where: { id: input.userId },
    data: { balance: Math.min(toChipNumber(nextBalance), 2_000_000_000), updatedAt: new Date() }
  })

  await tx.walletLedgerEntry.create({
    data: {
      walletId: wallet.id,
      roomId: input.roomId,
      memberId: input.memberId,
      transferId: input.transferId || randomUUID(),
      entryType: input.entryType,
      amount: input.delta,
      balanceAfter: nextBalance,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata || {}
    }
  })

  // Balance achievements must be evaluated against the canonical wallet,
  // not the legacy users.balance mirror or a stale pre-payout snapshot.
  const { unlockBalanceAchievements } = await import('./achievementService')
  await unlockBalanceAchievements(tx, input.userId, nextBalance)

  return updated
}

export async function recordRoomLedger(tx: Tx, input: {
  roomId: string
  memberId?: string
  marketId?: string
  transferId: string
  accountType: string
  entryType: string
  amount: bigint
  balanceAfter?: bigint
  idempotencyKey: string
  metadata?: Prisma.InputJsonValue
}) {
  if (input.amount === 0n) return null
  return tx.roomLedgerEntry.create({
    data: {
      roomId: input.roomId,
      memberId: input.memberId,
      marketId: input.marketId,
      transferId: input.transferId,
      accountType: input.accountType,
      entryType: input.entryType,
      amount: input.amount,
      balanceAfter: input.balanceAfter,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata || {}
    }
  })
}

export async function getWalletBalance(tx: Tx, userId: string): Promise<number> {
  return toChipNumber((await ensureUserWallet(tx, userId)).balance)
}

export async function getWalletHistory(token: string, limit = 50) {
  const { verifyUserAuthToken } = await import('./userAccountService')
  const auth = await verifyUserAuthToken(token)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  const { getPremiumAccess } = await import('./premiumService')
  const premium = await getPremiumAccess(auth.userId)
  const maxLimit = premium.features.includes('EXTENDED_HISTORY') ? 500 : 100
  const wallet = await prisma.userWallet.findUnique({ where: { userId: auth.userId } })
  if (!wallet) return { balance: 0, entries: [], maxLimit }
  const entries = await prisma.walletLedgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(maxLimit, limit))
  })
  return {
    balance: toChipNumber(wallet.balance),
    maxLimit,
    entries: entries.map(entry => ({
      id: entry.id,
      entryType: entry.entryType,
      amount: toChipNumber(entry.amount),
      balanceAfter: toChipNumber(entry.balanceAfter),
      metadata: entry.metadata,
      createdAt: entry.createdAt.toISOString()
    }))
  }
}
