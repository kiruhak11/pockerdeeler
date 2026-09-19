import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { ensureUserWallet } from './walletService'
import { buildSeasonAwards, collectSeasonMetrics, SEASON_CATEGORIES } from './seasonAwardService'
import { finalizeJackpot } from './jackpotService'
import { queueTelegramUserEvent } from './notificationService'
import { seasonFinishedEventKey, seasonStartedEventKey } from './telegramLifecycleService'

export { SEASON_CATEGORIES } from './seasonAwardService'
const STARTING_BALANCE = 50_000n
const STARTING_RATING = 1_000
const toNumber = (value: bigint | number) => typeof value === 'bigint' ? Number(value) : value

async function auth(token: string) {
  const verified = await verifyUserAuthToken(token)
  if (!verified) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return verified.userId
}

export async function ensureCurrentSeason(tx = prisma) {
  const now = new Date()
  const current = await tx.season.findFirst({ where: { status: 'active' }, orderBy: { number: 'desc' } })
  if (current) return current
  const last = await tx.season.findFirst({ orderBy: { number: 'desc' } })
  return tx.season.create({ data: { number: (last?.number ?? -1) + 1, status: 'active', startsAt: now, endsAt: new Date(now.getTime() + 10 * 86400000), startingBalance: STARTING_BALANCE } })
}

export async function ensureSeasonStats(userId: string, seasonId: string, tx = prisma) {
  return tx.seasonalUserStats.upsert({ where: { seasonId_userId: { seasonId, userId } }, create: { seasonId, userId, balance: STARTING_BALANCE, startingBalance: STARTING_BALANCE }, update: {} })
}

function snapshotData(user: {
  balance: bigint
  tableRating: number
  predictionRating: number
  tableHandsPlayed: number
  tableHandsWon: number
  tableCurrentStreak: number
  tableBestStreak: number
  predictionCount: number
  predictionWins: number
  predictionSplitWins: number
}) {
  return {
    balance: toNumber(user.balance),
    tableRating: user.tableRating,
    predictionRating: user.predictionRating,
    handsPlayed: user.tableHandsPlayed,
    handsWon: user.tableHandsWon,
    currentWinStreak: user.tableCurrentStreak,
    bestWinStreak: user.tableBestStreak,
    predictionCount: user.predictionCount,
    predictionWins: user.predictionWins,
    predictionSplitWins: user.predictionSplitWins
  }
}

function serializePrevious(previous: any) {
  if (!previous) return null
  const snapshot = previous.snapshots[0]
  if (!snapshot) return null
  return {
    seasonNumber: previous.number,
    finishedAt: previous.finalizedAt?.toISOString() ?? snapshot.createdAt.toISOString(),
    snapshot: snapshot.data,
    rewards: previous.rewards,
    acknowledged: Boolean(snapshot.acknowledgedAt)
  }
}

export async function seasonMe(token: string) {
  const userId = await auth(token)
  const season = await ensureCurrentSeason()
  const [user, previous] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { wallet: true } }),
    prisma.season.findFirst({
      where: { status: 'finished', snapshots: { some: { userId } } },
      orderBy: { number: 'desc' },
      include: { snapshots: { where: { userId } }, rewards: { where: { userId }, orderBy: { createdAt: 'asc' } } }
    })
  ])
  await ensureSeasonStats(userId, season.id)
  const previousResult = serializePrevious(previous)
  return {
    season: { id: season.id, number: season.number, status: season.status, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString(), startingBalance: toNumber(season.startingBalance) },
    stats: snapshotData({ ...user, balance: user.wallet?.balance ?? BigInt(user.balance) }),
    previous: previousResult,
    pendingResult: previousResult && !previousResult.acknowledged ? previousResult : null
  }
}

export async function acknowledgeSeasonResult(token: string) {
  const userId = await auth(token)
  const snapshot = await prisma.seasonSnapshot.findFirst({ where: { userId, season: { status: 'finished' } }, orderBy: { season: { number: 'desc' } } })
  if (!snapshot) return { acknowledged: false }
  await prisma.seasonSnapshot.updateMany({ where: { id: snapshot.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } })
  return { acknowledged: true }
}

export async function seasonLeaderboard(category: string, token?: string) {
  const season = await ensureCurrentSeason()
  const now = new Date()
  const userId = token ? await auth(token).catch(() => null) : null
  const key = SEASON_CATEGORIES.includes(category as typeof SEASON_CATEGORIES[number]) ? category : 'tableRating'
  const { rows } = await prisma.$transaction(async tx => {
    const users = await tx.user.findMany({ where: { deletedAt: null }, include: { wallet: true, premiumSubscriptions: { where: { status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' }, take: 1 } }, orderBy: { createdAt: 'asc' } })
    const rows = []
    for (const user of users) rows.push({ user, ...await collectSeasonMetrics(tx, season, user.id, snapshotData({ ...user, balance: user.wallet?.balance ?? BigInt(user.balance) })) })
    return { users, rows }
  }, { timeout: 30_000 })
  const eligible = rows.filter(row => {
    if (key === 'balance') return true
    if (key === 'tableRating' || key === 'handsPlayed') return row.handsPlayed > 0
    if (key === 'winRate') return row.handsPlayed >= 10
    if (key === 'predictionWins') return row.predictionCount > 0
    if (key === 'predictionPayout') return Number((row as any).predictionPayout) > 0
    if (key === 'bestWinStreak') return row.bestWinStreak > 0
    return true
  })
  const sorted = eligible.sort((a, b) => Number((b as any)[key]) - Number((a as any)[key]) || a.user.createdAt.getTime() - b.user.createdAt.getTime())
  return {
    season: { number: season.number, endsAt: season.endsAt.toISOString() }, category: key, currentUserId: userId,
    entries: sorted.slice(0, 100).map((row, index) => ({ rank: index + 1, userId: row.user.id, username: row.user.username, premiumType: row.user.premiumSubscriptions.length ? 'PREMIUM' : 'FREE', premiumPlan: row.user.premiumSubscriptions[0]?.plan || null, value: Number((row as any)[key]), handsPlayed: row.handsPlayed, handsWon: row.handsWon, predictionWins: row.predictionWins, bestWinStreak: row.bestWinStreak }))
  }
}

export async function finalizeSeason() {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
    const activeRoom = await tx.room.findFirst({ where: { status: { notIn: ['lobby', 'finished', 'cancelled'] } }, select: { id: true } })
    const unsettledPlayer = await tx.player.findFirst({ where: { balanceSettled: false }, select: { id: true } })
    const liveCrash = await tx.crashRound.findFirst({ where: { phase: { in: ['betting', 'flying'] } }, select: { id: true } })
    const liveMines = await tx.miniGameSession.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } })
    if (activeRoom || unsettledPlayer || liveCrash || liveMines) throw createError({ statusCode: 409, statusMessage: 'Сезон нельзя завершить, пока есть активная игра или нерассчитанный баланс' })

    const season = await tx.season.findFirst({ where: { status: 'active' }, orderBy: { number: 'desc' } })
    if (!season) throw createError({ statusCode: 404, statusMessage: 'Активный сезон не найден' })
    const locked = await tx.season.updateMany({ where: { id: season.id, status: 'active' }, data: { status: 'finalizing' } })
    if (!locked.count) return { alreadyFinalized: true }

    const users = await tx.user.findMany({ where: { deletedAt: null }, include: { wallet: true }, orderBy: { createdAt: 'asc' } })
    const results: Array<any> = []
    for (const user of users) {
      const wallet = user.wallet ?? await ensureUserWallet(tx, user.id)
      const data = await collectSeasonMetrics(tx, season, user.id, snapshotData({ ...user, balance: wallet.balance }))
      await tx.seasonSnapshot.create({ data: { seasonId: season.id, userId: user.id, data } })
      results.push({ user, wallet, ...data })
    }

    await buildSeasonAwards(tx, season, results.map(row => ({ ...row, userId: row.user.id })))
    await finalizeJackpot(tx, season)
    for (const row of results) {
      const delta = STARTING_BALANCE - row.wallet.balance
      const updatedWallet = await tx.userWallet.update({ where: { id: row.wallet.id }, data: { balance: STARTING_BALANCE, version: { increment: 1 }, updatedAt: new Date() } })
      // The ledger forbids zero-amount entries. A user already at the season
      // starting balance still needs the wallet reset/version update, but no
      // financial ledger row should be fabricated for a zero delta.
      if (delta !== 0n) await tx.walletLedgerEntry.create({ data: {
        walletId: updatedWallet.id, transferId: randomUUID(), entryType: 'SEASON_RESET', amount: delta, balanceAfter: STARTING_BALANCE,
        idempotencyKey: `season-reset:${season.number}:${row.user.id}`,
        metadata: { seasonNumber: season.number, previousBalance: row.balance, newBalance: Number(STARTING_BALANCE) }
      } })
      await tx.user.update({ where: { id: row.user.id }, data: {
        balance: Number(STARTING_BALANCE), tableRating: STARTING_RATING, predictionRating: STARTING_RATING,
        tableHandsPlayed: 0, tableHandsWon: 0, tableCurrentStreak: 0, tableBestStreak: 0,
        predictionCount: 0, predictionWins: 0, predictionSplitWins: 0, selectedAchievementCode: null, updatedAt: new Date()
      } })
      await tx.userAchievement.deleteMany({ where: { userId: row.user.id } })
    }

    const now = new Date()
    await tx.season.update({ where: { id: season.id }, data: { status: 'finished', finalizedAt: now } })
    const next = await tx.season.create({ data: { number: season.number + 1, status: 'active', startsAt: now, endsAt: new Date(now.getTime() + 10 * 86400000), startingBalance: STARTING_BALANCE } })
    if (users.length) await tx.seasonalUserStats.createMany({ data: users.map(user => ({ seasonId: next.id, userId: user.id, balance: STARTING_BALANCE, startingBalance: STARTING_BALANCE })), skipDuplicates: true })
    for (const user of users) {
      await queueTelegramUserEvent(tx, { userId: user.id, category: 'seasons', eventKey: seasonFinishedEventKey(season.id, user.id), text: `Сезон №${season.number} завершён. Итоги доступны в профиле.` })
      await queueTelegramUserEvent(tx, { userId: user.id, category: 'seasons', eventKey: seasonStartedEventKey(next.id, user.id), text: `Начался новый сезон №${next.number}. Удачи за столами!` })
    }
    return { seasonNumber: season.number, nextSeasonNumber: next.number, users: users.length }
  }, { timeout: 60_000 })
}

export async function rebuildSeasonAwards(seasonNumber: number) {
  return prisma.$transaction(async tx => {
    const season = await tx.season.findUnique({ where: { number: seasonNumber } })
    if (!season || season.status !== 'finished') throw createError({ statusCode: 404, statusMessage: 'Завершённый сезон не найден' })
    const snapshots = await tx.seasonSnapshot.findMany({ where: { seasonId: season.id }, orderBy: { createdAt: 'asc' } })
    const rows = []
    for (const snapshot of snapshots) {
      const metrics = await collectSeasonMetrics(tx, season, snapshot.userId, snapshot.data as Record<string, any>)
      await tx.seasonSnapshot.update({ where: { id: snapshot.id }, data: { data: metrics } })
      rows.push(metrics)
    }
    await tx.seasonLeaderboard.deleteMany({ where: { seasonId: season.id } })
    await tx.seasonReward.deleteMany({ where: { seasonId: season.id } })
    await buildSeasonAwards(tx, season, rows)
    return { seasonNumber, users: rows.length, rewards: await tx.seasonReward.count({ where: { seasonId: season.id } }) }
  }, { timeout: 120_000 })
}
