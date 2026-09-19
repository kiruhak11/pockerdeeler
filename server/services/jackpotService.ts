import type { Prisma, Season } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { drawWinners, splitJackpotTenths, JACKPOT_SHARES } from '../utils/jackpotMath'
import { adjustUserWallet } from './walletService'
import { verifyUserAuthToken } from './userAccountService'

type Tx = Prisma.TransactionClient
export async function jackpotParticipants(tx: Tx, season: Pick<Season, 'startsAt' | 'finalizedAt' | 'number'>) {
  if (season.number < 1) return []
  const end = season.finalizedAt ?? new Date()
  const rows = await tx.$queryRaw<Array<{ userId: string; username: string; lost: bigint; games: bigint }>>`
    SELECT u.id AS "userId", u.username, SUM(g.lost)::bigint AS lost, COUNT(*)::bigint AS games
    FROM (
      SELECT user_id, CASE WHEN status='LOST' THEN stake ELSE 0 END AS lost
      FROM mini_game_sessions WHERE game='mines' AND created_at >= ${season.startsAt} AND created_at < ${end}
      UNION ALL
      SELECT b.user_id, CASE WHEN r.phase='crashed' AND b.payout=0 THEN b.stake::bigint ELSE 0 END AS lost
      FROM crash_bets b JOIN crash_rounds r ON r.id=b.round_id
      WHERE b.created_at >= ${season.startsAt} AND b.created_at < ${end}
    ) g JOIN users u ON u.id=g.user_id
    WHERE u.deleted_at IS NULL AND u.blocked_at IS NULL
    GROUP BY u.id,u.username ORDER BY SUM(g.lost) DESC,u.id`
  // One base ticket ensures every participant is eligible, even without losses.
  const total = rows.reduce((sum, row) => sum + row.lost + 1n, 0n)
  return rows.map(row => ({ userId: row.userId, username: row.username, lost: Number(row.lost), games: Number(row.games), weight: row.lost + 1n, chance: Number((row.lost + 1n) * 1_000_000n / total) / 10_000 }))
}

export async function finalizeJackpot(tx: Tx, season: Season) {
  if (season.number < 1 || await tx.jackpotDraw.findUnique({ where: { seasonId: season.id } })) return
  await tx.$queryRaw`SELECT id FROM mini_game_economy WHERE id='global' FOR UPDATE`
  const economy = await tx.miniGameEconomy.findUniqueOrThrow({ where: { id: 'global' } })
  const participants = await jackpotParticipants(tx, season)
  const winners = drawWinners(participants)
  const prizes = splitJackpotTenths(economy.jackpotTenths)
  await tx.jackpotDraw.create({ data: {
    seasonId: season.id, seasonNumber: season.number, pot: economy.jackpotTenths / 10n, potTenths: economy.jackpotTenths,
    participants: participants.map(({ weight, ...p }) => p),
    prizes: { create: winners.map((winner, i) => ({ userId: winner.userId, username: winner.username, place: i + 1, amount: prizes[i]! / 10n })) }
  } })
  // Reserved prizes cannot be spent by games or reduced while awaiting a claim.
  const reservedTenths = winners.reduce((sum, _, i) => sum + prizes[i]!, 0n)
  const remainingTenths = economy.jackpotTenths - reservedTenths
  await tx.miniGameEconomy.update({ where: { id: 'global' }, data: { jackpotTenths: remainingTenths, jackpot: remainingTenths / 10n, updatedAt: new Date() } })
}

export async function jackpotState(token?: string | null) {
  const auth = token ? await verifyUserAuthToken(token) : null
  const draws = await prisma.jackpotDraw.findMany({ orderBy: { seasonNumber: 'desc' }, include: { prizes: { orderBy: { place: 'asc' } } } })
  return { shares: JACKPOT_SHARES, currentUserId: auth?.userId ?? null, history: draws.map(draw => ({
    id: draw.id, seasonNumber: draw.seasonNumber, pot: Number(draw.pot), createdAt: draw.createdAt.toISOString(),
    prizes: draw.prizes.map(prize => ({ id: prize.id, place: prize.place, username: prize.username, amount: Number(prize.amount), claimedAt: prize.claimedAt?.toISOString() ?? null, mine: prize.userId === auth?.userId }))
  })) }
}

export async function claimJackpot(token: string | null | undefined, prizeId: string) {
  const auth = token ? await verifyUserAuthToken(token) : null
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return prisma.$transaction(async tx => {
    // Serializes claims with season resets, so a claim cannot be erased by one.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
    const prize = await tx.jackpotPrize.findFirst({ where: { id: prizeId, userId: auth.userId }, include: { draw: { include: { season: true } } } })
    if (!prize) throw createError({ statusCode: 404, statusMessage: 'Награда не найдена' })
    const next = await tx.season.findFirst({ where: { number: { gt: prize.draw.seasonNumber } } })
    if (!next || prize.draw.season.status !== 'finished') throw createError({ statusCode: 409, statusMessage: 'Награда доступна после перехода сезона' })
    if (!prize.claimedAt) {
      if (prize.amount > 0n) await adjustUserWallet(tx, { userId: auth.userId, delta: prize.amount, entryType: 'JACKPOT_PRIZE', idempotencyKey: `jackpot:prize:${prize.id}`, metadata: { seasonNumber: prize.draw.seasonNumber, place: prize.place } })
      await tx.jackpotPrize.update({ where: { id: prize.id }, data: { claimedAt: new Date() } })
    }
    return { amount: Number(prize.amount), alreadyClaimed: Boolean(prize.claimedAt) }
  })
}
