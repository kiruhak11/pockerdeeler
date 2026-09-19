import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { jackpotParticipants } from './jackpotService'

type Tx = Prisma.TransactionClient
const ECONOMY_ID = 'global'
const MINES_DAILY_BANK = 2_000_000n
const ROCKET_DAILY_BANK = 5_000_000n
const utcDay = () => new Date().toISOString().slice(0, 10)
const RECENT_WINDOW_MS = 60 * 60 * 1000

/**
 * Applies a bounded, server-side cooling factor after a player's recent
 * mini-game run became strongly positive. This is deliberately based on the
 * wallet ledger (not the displayed balance), is shared by both games, and is
 * capped so an individual round can still win.
 */
export async function recentMiniGameThrottle(tx: Tx, input: { game: 'mines' | 'rocket'; userId: string; payout: bigint }) {
  const entryTypes = input.game === 'mines' ? ['MINES_STAKE', 'MINES_PAYOUT'] : ['CRASH_STAKE', 'CRASH_PAYOUT']
  const payout = input.payout
  if (payout <= 0n) return { payout, recentNet: 0n, factorBps: 10_000 }
  const [wallet, user] = await Promise.all([
    tx.userWallet.findUnique({ where: { userId: input.userId }, select: { id: true } }),
    tx.user.findUnique({ where: { id: input.userId }, select: { miniGameResetAt: true } })
  ])
  if (!wallet) return { payout, recentNet: 0n, factorBps: 10_000 }
  const windowStart = new Date(Date.now() - RECENT_WINDOW_MS)
  const since = user?.miniGameResetAt && user.miniGameResetAt > windowStart ? user.miniGameResetAt : windowStart
  const result = await tx.walletLedgerEntry.aggregate({
    where: { walletId: wallet.id, createdAt: { gte: since }, entryType: { in: entryTypes } },
    _sum: { amount: true }
  })
  const recentNet = result._sum.amount || 0n
  const positive = recentNet > 0n ? recentNet : 0n
  // From 0% to at most 35% pressure as the last-hour net profit grows.
  const pressureBps = positive >= 2_000_000n ? 3_500 : Number(positive * 3_500n / 2_000_000n)
  const factorBps = 10_000 - pressureBps
  return { payout: payout * BigInt(factorBps) / 10_000n, recentNet, factorBps }
}

export async function ensureMiniGameEconomy(tx: Tx) {
  const dayKey = utcDay()
  await tx.miniGameEconomy.upsert({
    where: { id: ECONOMY_ID },
    create: { id: ECONOMY_ID, dayKey, minesBank: MINES_DAILY_BANK, rocketBank: ROCKET_DAILY_BANK, jackpot: 0n, jackpotTenths: 0n },
    update: {}
  })
  const row = await tx.miniGameEconomy.findUniqueOrThrow({ where: { id: ECONOMY_ID } })
  if (row.dayKey !== dayKey) return tx.miniGameEconomy.update({ where: { id: ECONOMY_ID }, data: { dayKey, minesBank: MINES_DAILY_BANK, rocketBank: ROCKET_DAILY_BANK, updatedAt: new Date() } })
  return row
}

export async function settleMiniGameEconomy(tx: Tx, input: { game: 'mines' | 'rocket'; userId: string; stake: bigint; payout: bigint; referenceId: string }) {
  const current = await ensureMiniGameEconomy(tx)
  await tx.$queryRaw`SELECT id FROM mini_game_economy WHERE id=${ECONOMY_ID} FOR UPDATE`
  const economy = await tx.miniGameEconomy.findUniqueOrThrow({ where: { id: ECONOMY_ID } })
  if (input.payout === 0n) {
    const nextJackpotTenths = economy.jackpotTenths + input.stake
    await tx.miniGameEconomy.update({ where: { id: ECONOMY_ID }, data: { jackpotTenths: nextJackpotTenths, jackpot: nextJackpotTenths / 10n, updatedAt: new Date() } })
    await tx.miniGameJackpotEntry.create({ data: { id: randomUUID(), economyId: ECONOMY_ID, userId: input.userId, game: input.game, amount: input.stake, source: 'LOSS', referenceId: input.referenceId } })
  } else {
    const bank = input.game === 'mines' ? economy.minesBank : economy.rocketBank
    const fromBank = bank < input.payout ? bank : input.payout
    const remaining = input.payout - fromBank
    const remainingTenths = remaining * 10n
    const fromJackpotTenths = economy.jackpotTenths < remainingTenths ? economy.jackpotTenths : remainingTenths
    const nextJackpotTenths = economy.jackpotTenths - fromJackpotTenths
    const data = input.game === 'mines'
      ? { minesBank: { decrement: fromBank }, jackpotTenths: nextJackpotTenths, jackpot: nextJackpotTenths / 10n, updatedAt: new Date() }
      : { rocketBank: { decrement: fromBank }, jackpotTenths: nextJackpotTenths, jackpot: nextJackpotTenths / 10n, updatedAt: new Date() }
    await tx.miniGameEconomy.update({ where: { id: ECONOMY_ID }, data })
  }
  return getEconomySnapshot(tx)
}

export async function getEconomySnapshot(tx: Tx = prisma as unknown as Tx) {
  const economy = await ensureMiniGameEconomy(tx)
  const season = await tx.season.findFirst({ where: { status: 'active' }, orderBy: { number: 'desc' } })
  const participants = season ? await jackpotParticipants(tx, season) : []
  return { minesBank: Number(economy.minesBank), rocketBank: Number(economy.rocketBank), jackpot: Number(economy.jackpotTenths) / 10, updatedAt: economy.updatedAt.toISOString(),
    season: season ? { number: season.number, endsAt: season.endsAt.toISOString() } : null,
    participants: participants.map(({ weight, ...p }) => p) }
}

export async function miniGameEconomyState() { return prisma.$transaction(tx => getEconomySnapshot(tx)) }
