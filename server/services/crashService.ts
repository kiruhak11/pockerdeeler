import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { adjustUserWallet } from './walletService'
import { getEconomySnapshot, recentMiniGameThrottle, settleMiniGameEconomy } from './miniGameEconomyService'
import { crashAtFromUnit } from '../utils/crashMath'
import { lockOnlineFundsTransition } from './onlineRoomAccountingService'

const BETTING_MS = 15_000
const ROUND_GAP_MS = 2_500
const CRASH_LOCK = 928_374
type Tx = Prisma.TransactionClient

export type BotRocketFence = Readonly<{
  key: string
  token: string
  isLeaseCurrent: () => Promise<boolean>
}>

export type BotRocketSnapshot = Readonly<{
  roundId: string
  phase: 'betting' | 'flying' | 'crashed'
  bettingMsRemaining: number
  bots: Readonly<Record<string, Readonly<{ balance: number; hasBet: boolean; recentNet?: number; recentCount?: number }>>>
}>

function botLeaseError() {
  return Object.assign(createError({ statusCode: 409, statusMessage: 'Bot lease is no longer valid.' }), { code: 'BOT_LEASE_LOST' })
}

function fenceGeneration(fence: BotRocketFence): bigint {
  const match = /^(\d+):([A-Za-z0-9_-]{1,128})$/.exec(fence.token)
  if (!match) throw botLeaseError()
  return BigInt(match[1]!)
}

async function persistBotRocketFence(tx: Tx, userId: string, fence: BotRocketFence) {
  if (!await fence.isLeaseCurrent().catch(() => false)) throw botLeaseError()
  const nextFence = fenceGeneration(fence)
  const bot = await tx.user.findUnique({ where: { id: userId }, select: { botKey: true, isBot: true, botEnabled: true } })
  // Lease namespaces are injected by the orchestrator (and isolated tests may
  // use a private prefix); the final key segment must still identify this bot.
  if (!bot?.isBot || !bot.botEnabled || !bot.botKey || !fence.key.endsWith(`:${bot.botKey}`)) throw botLeaseError()

  // Persist the Redis generation in PostgreSQL. Lease registration and every
  // Rocket wallet mutation take CRASH_LOCK, so takeover is serialized against
  // an in-flight old worker before the new lease is allowed to act.
  const accepted = await tx.user.updateMany({
    where: { id: userId, isBot: true, botEnabled: true, botFencingToken: { lte: nextFence } },
    data: { botFencingToken: nextFence }
  })
  if (accepted.count !== 1) throw botLeaseError()
}

/** Register a newly acquired shared bot lease before the worker can act. */
export async function registerBotRocketLease(userId: string, fence: BotRocketFence): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRASH_LOCK})`
    await persistBotRocketFence(tx, userId, fence)
  })
}

/** Server-only snapshot for the existing bot orchestrator; never includes outcome secrets. */
export async function getBotRocketSnapshot(
  botIds: readonly string[],
  assertSchedulerLease: () => Promise<boolean>
): Promise<BotRocketSnapshot> {
  return prisma.$transaction(async tx => {
    const round = await currentRound(tx)
    if (!await assertSchedulerLease().catch(() => false)) throw botLeaseError()
    await settleAutoCashouts(tx, round)
    const ids = [...new Set(botIds)]
    const users = await tx.user.findMany({
      where: { id: { in: ids }, isBot: true, botEnabled: true },
      select: { id: true, wallet: { select: { balance: true } } }
    })
    const bets = await tx.crashBet.findMany({ where: { roundId: round.id, userId: { in: ids } }, select: { userId: true } })
    const alreadyBet = new Set(bets.map(bet => bet.userId))
    const recent = ids.length ? await tx.$queryRaw<Array<{ user_id: string; recent_net: bigint; recent_count: bigint }>>`
      SELECT bots.user_id::text, SUM(history.payout - history.stake)::bigint AS recent_net, COUNT(*)::bigint AS recent_count
      FROM unnest(${ids}::uuid[]) AS bots(user_id)
      CROSS JOIN LATERAL (
        SELECT b.payout, b.stake
        FROM crash_bets b
        JOIN crash_rounds r ON r.id = b.round_id
        WHERE b.user_id = bots.user_id AND r.phase = 'crashed'
        ORDER BY b.created_at DESC
        LIMIT 5
      ) history
      GROUP BY bots.user_id
    ` : []
    const recentByUser = new Map(recent.map(item => [item.user_id, { recentNet: Number(item.recent_net), recentCount: Number(item.recent_count) }]))
    const bots: Record<string, { balance: number; hasBet: boolean; recentNet: number; recentCount: number }> = Object.create(null)
    for (const user of users) {
      if (!user.wallet) continue
      const history = recentByUser.get(user.id)
      bots[user.id] = { balance: Number(user.wallet.balance), hasBet: alreadyBet.has(user.id), recentNet: history?.recentNet ?? 0, recentCount: history?.recentCount ?? 0 }
    }
    const phase = round.phase
    if (phase !== 'betting' && phase !== 'flying' && phase !== 'crashed') throw new Error('Rocket round phase is invalid.')
    return Object.freeze({
      roundId: round.id,
      phase,
      bettingMsRemaining: phase === 'betting' ? Math.max(0, BETTING_MS - (Date.now() - round.startedAt.getTime())) : 0,
      bots: Object.freeze(bots)
    })
  })
}

function isInsufficientWalletFunds(error: unknown): boolean {
  const value = error as { statusCode?: unknown; statusMessage?: unknown } | null
  return value?.statusCode === 409 && typeof value.statusMessage === 'string'
    && value.statusMessage.includes('недостаточно свободных фишек')
}

function validateCrashBetInput(stake: number, autoCashout: number | null) {
  if (!Number.isSafeInteger(stake) || stake < 1 || stake > 1_000_000) throw createError({ statusCode: 400, statusMessage: 'Ставка должна быть от 1 до 1 000 000' })
  if (autoCashout !== null && (!Number.isFinite(autoCashout) || Math.round(autoCashout * 100) / 100 !== autoCashout || autoCashout < 1.01 || autoCashout > 1000)) throw createError({ statusCode: 400, statusMessage: 'Автовывод должен быть от 1.01x до 1000x, максимум 2 знака после запятой' })
  return autoCashout === null ? null : Math.floor(autoCashout * 100)
}

async function placeCrashBetForUser(
  userId: string,
  stake: number,
  autoCashout: number | null,
  botOptions?: Readonly<{ expectedRoundId: string; fence: BotRocketFence }>
) {
  const autoCashoutAt = validateCrashBetInput(stake, autoCashout)
  try {
    return await prisma.$transaction(async tx => {
      // Take the same lock used by currentRound before checking/recording the
      // lease. Serialize against ONLINE buy-in/cash-out transitions as well,
      // so a seat cannot become RESERVING between the poker-priority check and
      // the wallet debit. A takeover registers its newer generation under this lock too.
      if (botOptions) {
        await lockOnlineFundsTransition(tx)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRASH_LOCK})`
        await persistBotRocketFence(tx, userId, botOptions.fence)
        const pokerReservation = await tx.onlineRoomPlayer.findFirst({
          where: { userId, status: { in: ['RESERVING', 'ACTIVE', 'CASH_OUT_PENDING'] } },
          select: { id: true }
        })
        if (pokerReservation) return false
      }
      const round = await currentRound(tx)
      if (botOptions && (round.id !== botOptions.expectedRoundId || round.phase !== 'betting')) return false
      if (round.phase !== 'betting') throw createError({ statusCode: 409, statusMessage: 'Ставки принимаются только до взлёта' })
      const existing = await tx.crashBet.findUnique({ where: { roundId_userId: { roundId: round.id, userId } } })
      if (existing) {
        if (botOptions) return false
        throw createError({ statusCode: 409, statusMessage: 'Ставка уже сделана' })
      }
      await adjustUserWallet(tx, { userId, delta: -BigInt(stake), entryType: 'CRASH_STAKE', idempotencyKey: `crash:stake:${round.id}:${userId}`, metadata: { roundId: round.id } })
      await tx.crashBet.create({ data: { roundId: round.id, userId, stake, autoCashout: autoCashoutAt } })
      if (botOptions) return true
      return response(tx, userId)
    })
  } catch (error) {
    if (botOptions && isInsufficientWalletFunds(error)) return false
    throw error
  }
}

/** Fenced, account-backed bot bet using the same round, wallet, ledger and CrashBet path as humans. */
export async function placeCrashBetForBot(
  userId: string,
  input: Readonly<{ expectedRoundId: string; stake: number; autoCashout: number | null }>,
  fence: BotRocketFence
): Promise<boolean> {
  if (!input.expectedRoundId) return false
  return Boolean(await placeCrashBetForUser(userId, input.stake, input.autoCashout, {
    expectedRoundId: input.expectedRoundId,
    fence
  }))
}

function newSeed() {
  const seed = randomBytes(32).toString('hex')
  const value = (Number(BigInt(`0x${seed.slice(0, 13)}`)) + 1) / 0x10000000000000
  // A rare instant crash at 1.00x is valid and is what gives a 1.01x
  // auto-cashout a real, measurable house edge.
  const crashAt = crashAtFromUnit(value)
  return { seed, crashAt, seedHash: createHash('sha256').update(seed).digest('hex') }
}

function multiplier(startedAt: Date, phase: string) {
  if (phase === 'betting') return 100
  return Math.max(100, Math.floor(Math.exp((Date.now() - startedAt.getTime() - BETTING_MS) / 8_500) * 100))
}

async function userIdFromToken(token?: string | null) {
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  const result = await verifyUserAuthToken(token)
  if (!result) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return result.userId
}

async function currentRound(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRASH_LOCK})`
  let round = await tx.crashRound.findFirst({ where: { phase: { in: ['betting', 'flying'] } }, orderBy: { createdAt: 'desc' } })
  if (!round) {
    const latest = await tx.crashRound.findFirst({ orderBy: { createdAt: 'desc' } })
    if (latest && Date.now() - latest.updatedAt.getTime() < ROUND_GAP_MS) return latest
    const generated = newSeed()
    round = await tx.crashRound.create({ data: { id: randomUUID(), phase: 'betting', startedAt: new Date(), crashAt: generated.crashAt, seedHash: generated.seedHash, seed: generated.seed } })
  }
  const age = Date.now() - round.startedAt.getTime()
  if (round.phase === 'betting' && age >= BETTING_MS) round = await tx.crashRound.update({ where: { id: round.id }, data: { phase: 'flying' } })
  if (round.phase === 'flying' && multiplier(round.startedAt, round.phase) >= round.crashAt) round = await tx.crashRound.update({ where: { id: round.id }, data: { phase: 'crashed' } })
  if (round.phase === 'crashed' && Date.now() - round.updatedAt.getTime() >= ROUND_GAP_MS) {
    const generated = newSeed()
    round = await tx.crashRound.create({ data: { id: randomUUID(), phase: 'betting', startedAt: new Date(), crashAt: generated.crashAt, seedHash: generated.seedHash, seed: generated.seed } })
  }
  return round
}

async function settleAutoCashouts(tx: Tx, round: Awaited<ReturnType<typeof currentRound>>) {
  if (round.phase !== 'flying' && round.phase !== 'crashed') return
  // A very short round can move from flying to crashed between two client polls.
  // Settle targets reached at the crash boundary as well, including 1.01x.
  const at = round.phase === 'crashed' ? round.crashAt : Math.min(multiplier(round.startedAt, round.phase), round.crashAt)
  // Only explicit auto-cashout bets may be settled here. A manual bet with
  // autoCashout = null must remain in play until the player presses cashout;
  // otherwise every state poll would silently cash it out at the current x.
  const bets = await tx.crashBet.findMany({ where: { roundId: round.id, cashedAt: null, ...(round.phase === 'crashed' ? {} : { autoCashout: { not: null } }) } })
  for (const bet of bets) {
    const target = bet.autoCashout || at
    const won = bet.autoCashout !== null && target <= at
    // While the rocket is still flying, an auto-cashout target that has not
    // been reached must remain active. Closing it at the current multiplier
    // would incorrectly turn a 1.01x (or any higher) target into a loss at
    // 1.00x during the first state poll.
    if (!won && round.phase !== 'crashed') continue
    const rawPayout = won ? BigInt(Math.floor(bet.stake * target / 100)) : 0n
    const throttled = await recentMiniGameThrottle(tx, { game: 'rocket', userId: bet.userId, payout: rawPayout })
    const payout = Number(throttled.payout)
    const updated = await tx.crashBet.updateMany({ where: { id: bet.id, cashedAt: null }, data: { cashedAt: won ? target : at, payout } })
    if (updated.count !== 1) continue
    await settleMiniGameEconomy(tx, { game: 'rocket', userId: bet.userId, stake: BigInt(bet.stake), payout: throttled.payout, referenceId: bet.id })
    if (payout) await adjustUserWallet(tx, { userId: bet.userId, delta: throttled.payout, entryType: 'CRASH_PAYOUT', idempotencyKey: `crash:payout:${round.id}:${bet.userId}`, metadata: { roundId: round.id, multiplier: target / 100, automatic: Boolean(bet.autoCashout), recentNet: Number(throttled.recentNet), throttleBps: throttled.factorBps } })
  }
}

async function response(tx: Tx, userId: string) {
  const round = await currentRound(tx)
  await settleAutoCashouts(tx, round)
  const bet = await tx.crashBet.findUnique({ where: { roundId_userId: { roundId: round.id, userId } } })
  const currentBets = await tx.crashBet.findMany({ where: { roundId: round.id }, orderBy: { createdAt: 'asc' }, select: { id: true, stake: true, cashedAt: true, payout: true, autoCashout: true, user: { select: { username: true } } } })
  const history = await tx.crashRound.findMany({ where: { phase: 'crashed' }, orderBy: { updatedAt: 'desc' }, take: 10, select: { id: true, crashAt: true, seedHash: true } })
  const wallet = await tx.userWallet.findUniqueOrThrow({ where: { userId }, select: { balance: true } })
  const economy = await getEconomySnapshot(tx)
  return {
    balance: Number(wallet.balance),
    round: { id: round.id, phase: round.phase, multiplier: round.phase === 'crashed' ? round.crashAt / 100 : multiplier(round.startedAt, round.phase) / 100, startsInMs: round.phase === 'betting' ? Math.max(0, BETTING_MS - (Date.now() - round.startedAt.getTime())) : 0, crashAt: round.phase === 'crashed' ? round.crashAt / 100 : null, seedHash: round.seedHash },
    bet: bet ? { stake: bet.stake, cashedAt: bet.cashedAt ? bet.cashedAt / 100 : null, payout: bet.payout, autoCashout: bet.autoCashout ? bet.autoCashout / 100 : null } : null,
    stats: { players: currentBets.length, totalStake: currentBets.reduce((total, item) => total + item.stake, 0) },
    currentBets: currentBets.map(item => ({ id: item.id, username: item.user.username, stake: item.stake, cashedAt: item.cashedAt ? item.cashedAt / 100 : null, payout: item.payout, autoCashout: item.autoCashout ? item.autoCashout / 100 : null })),
    history: history.map(item => ({ id: item.id, crashAt: item.crashAt / 100, seedHash: item.seedHash })), economy
  }
}

export async function crashState(token?: string | null) {
  const userId = await userIdFromToken(token)
  return prisma.$transaction(tx => response(tx, userId))
}

export async function placeCrashBet(token: string | null | undefined, stake: number, autoCashout: number | null = null) {
  const userId = await userIdFromToken(token)
  return placeCrashBetForUser(userId, stake, autoCashout)
}

export async function cashoutCrash(token: string | null | undefined) {
  const userId = await userIdFromToken(token)
  return prisma.$transaction(async tx => {
    const round = await currentRound(tx)
    if (round.phase !== 'flying') throw createError({ statusCode: 409, statusMessage: 'Сейчас вывести ставку нельзя' })
    const at = multiplier(round.startedAt, round.phase)
    const bet = await tx.crashBet.findUnique({ where: { roundId_userId: { roundId: round.id, userId } } })
    if (!bet || bet.cashedAt !== null) throw createError({ statusCode: 409, statusMessage: 'Сейчас вывести ставку нельзя' })
    const rawPayout = BigInt(Math.floor(bet.stake * at / 100))
    const throttled = await recentMiniGameThrottle(tx, { game: 'rocket', userId, payout: rawPayout })
    const payout = Number(throttled.payout)
    const updated = await tx.crashBet.updateMany({ where: { id: bet.id, cashedAt: null }, data: { cashedAt: at, payout } })
    if (updated.count !== 1) throw createError({ statusCode: 409, statusMessage: 'Выигрыш уже забран' })
    await settleMiniGameEconomy(tx, { game: 'rocket', userId, stake: BigInt(bet.stake), payout: throttled.payout, referenceId: bet.id })
    if (payout) await adjustUserWallet(tx, { userId, delta: throttled.payout, entryType: 'CRASH_PAYOUT', idempotencyKey: `crash:payout:${round.id}:${userId}`, metadata: { roundId: round.id, multiplier: at / 100, recentNet: Number(throttled.recentNet), throttleBps: throttled.factorBps } })
    return response(tx, userId)
  })
}
