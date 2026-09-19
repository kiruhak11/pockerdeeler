import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { adjustUserWallet } from './walletService'
import { getEconomySnapshot, recentMiniGameThrottle, settleMiniGameEconomy } from './miniGameEconomyService'
import { crashAtFromUnit } from '../utils/crashMath'

const BETTING_MS = 15_000
const ROUND_GAP_MS = 2_500
const CRASH_LOCK = 928_374
type Tx = Prisma.TransactionClient

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
  if (!Number.isSafeInteger(stake) || stake < 1 || stake > 1_000_000) throw createError({ statusCode: 400, statusMessage: 'Ставка должна быть от 1 до 1 000 000' })
  if (autoCashout !== null && (!Number.isFinite(autoCashout) || Math.round(autoCashout * 100) / 100 !== autoCashout || autoCashout < 1.01 || autoCashout > 1000)) throw createError({ statusCode: 400, statusMessage: 'Автовывод должен быть от 1.01x до 1000x, максимум 2 знака после запятой' })
  const autoCashoutAt = autoCashout === null ? null : Math.floor(autoCashout * 100)
  return prisma.$transaction(async tx => {
    const round = await currentRound(tx)
    if (round.phase !== 'betting') throw createError({ statusCode: 409, statusMessage: 'Ставки принимаются только до взлёта' })
    const existing = await tx.crashBet.findUnique({ where: { roundId_userId: { roundId: round.id, userId } } })
    if (existing) throw createError({ statusCode: 409, statusMessage: 'Ставка уже сделана' })
    await adjustUserWallet(tx, { userId, delta: -BigInt(stake), entryType: 'CRASH_STAKE', idempotencyKey: `crash:stake:${round.id}:${userId}`, metadata: { roundId: round.id } })
    await tx.crashBet.create({ data: { roundId: round.id, userId, stake, autoCashout: autoCashoutAt } })
    return response(tx, userId)
  })
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
