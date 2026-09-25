import { randomBytes } from 'node:crypto'
import type { MiniGameSession, Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { adjustUserWallet, lockUserWallet } from './walletService'
import { getEconomySnapshot, recentMiniGameThrottle, settleMiniGameEconomy } from './miniGameEconomyService'
import { MINES_COLUMNS, MINES_COUNT, legacyMinesField, legacyMinesTerms, minesField, minesLimit, minesTerms, seedHash } from '../utils/minesMath'
import { minesStartInputSchema, type MinesStartInput } from '../utils/minesValidation'

type Tx = Prisma.TransactionClient
const LEGACY_MINES_CUTOFF = new Date('2026-09-18T14:15:00.000Z')
// The VPS clock is one day behind the local workstation clock. Keep the
// rollout boundary in server time so games created after this deployment use
// the new curve while already settled games retain their original payout.
const CURVE_MINES_CUTOFF = new Date('2026-09-18T16:16:00.000Z')
const ECONOMY_CUTOFF = new Date('2026-09-18T15:00:00.000Z')
const STALE_SESSION_MS = 6 * 60 * 60 * 1000
function openedCells(session: MiniGameSession) { return session.openedCells as number[] }
function classicMinesTerms(stake: bigint, mines: number, opened: number, limit: bigint) {
  const multiplierBps = Math.round((11000 + (mines - 1) * (250000 - 11000) / 23))
  const raw = stake * BigInt(multiplierBps) / 10000n
  const payout = raw < limit ? raw : limit
  return { payout, multiplier: Number(payout * 10000n / stake) / 10000, multiplierBps, capped: raw >= limit, safeChance: (25 - mines) / 25, riskPercent: mines / 25 }
}
function sessionTerms(session: MiniGameSession, opened: number) {
  if (session.createdAt < LEGACY_MINES_CUTOFF) return legacyMinesTerms(session.stake, session.mines!, opened, session.maxPayout)
  if (session.createdAt < CURVE_MINES_CUTOFF) return classicMinesTerms(session.stake, session.mines!, opened, session.maxPayout)
  return minesTerms(session.stake, session.mines!, opened, session.maxPayout)
}
function view(session: MiniGameSession) {
  const opened = openedCells(session)
  const safe = session.status === 'LOST' ? opened.length - 1 : opened.length
  const terms = sessionTerms(session, safe)
  const finished = session.status !== 'ACTIVE'
  return {
    id: session.id, status: session.status, stake: Number(session.stake), mines: session.mines!,
    serverSeedHash: session.serverSeedHash, ...(finished ? { serverSeed: session.serverSeed, mineCells: session.mineCells } : {}),
    clientSeed: session.clientSeed, nonce: session.nonce, openedCells: opened, safeOpened: safe,
    multiplier: terms.multiplier, potentialPayout: Number(terms.payout), payout: Number(session.payout),
    safeRemaining: Math.max(0, 25 - session.mines! - safe), currentColumn: 0, columns: 25,
    nextRisk: session.status === 'ACTIVE' ? terms.riskPercent : null,
    createdAt: session.createdAt.toISOString(), finishedAt: session.finishedAt?.toISOString()
  }
}
async function userId(token?: string | null) {
  const auth = token ? await verifyUserAuthToken(token) : null
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return auth.userId
}
async function bankUser() {
  const owner = await prisma.user.findFirst({ where: { deletedAt: null, blockedAt: null, ...(process.env.OWNER_PHONE ? { phone: process.env.OWNER_PHONE } : { role: { in: ['SUPERADMIN', 'ADMIN'] } }) }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!owner) throw createError({ statusCode: 503, statusMessage: 'Игровой банк пока недоступен' })
  return owner.id
}
async function lockUsers(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await lockUserWallet(tx, id)
}
async function lockedSession(tx: Tx, id: string, sessionId: string) {
  await tx.$queryRaw`SELECT id FROM mini_game_sessions WHERE id=CAST(${sessionId} AS uuid) AND user_id=CAST(${id} AS uuid) FOR UPDATE`
  const session = await tx.miniGameSession.findFirst({ where: { id: sessionId, userId: id, game: 'mines' } })
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Игра не найдена' })
  return session
}
async function finish(tx: Tx, session: MiniGameSession, status: 'LOST' | 'CASHED_OUT', opened: number[]) {
  const rawPayout = status === 'LOST' ? 0n : sessionTerms(session, opened.length).payout
  const throttled = await recentMiniGameThrottle(tx, { game: 'mines', userId: session.userId, payout: rawPayout })
  const payout = throttled.payout
  const modernEconomy = session.createdAt >= ECONOMY_CUTOFF
  await lockUsers(tx, [session.userId, session.bankUserId])
  const sameAsBank = session.userId === session.bankUserId
  const returned = session.stake + session.bankReserve - payout
  if (!sameAsBank && returned < 0n) throw new Error('Mines reserve invariant violated')
  await tx.walletLedgerEntry.update({ where: { idempotencyKey: `mines:stake:${session.id}` }, data: { metadata: { sessionId: session.id, mines: session.mines, outcome: status, payout: Number(payout), stake: Number(session.stake), recentNet: Number(throttled.recentNet), throttleBps: throttled.factorBps } } })
  if (modernEconomy) await settleMiniGameEconomy(tx, { game: 'mines', userId: session.userId, stake: session.stake, payout, referenceId: session.id })
  if (payout) await adjustUserWallet(tx, { userId: session.userId, delta: payout, entryType: 'MINES_PAYOUT', transferId: session.id, idempotencyKey: `mines:payout:${session.id}`, metadata: { sessionId: session.id, mines: session.mines, safeOpened: opened.length } })
  if (returned && !sameAsBank) await adjustUserWallet(tx, { userId: session.bankUserId, delta: returned, entryType: 'MINES_BANK_SETTLEMENT', transferId: session.id, idempotencyKey: `mines:bank-return:${session.id}`, metadata: { sessionId: session.id, outcome: status, reserveReturned: Number(session.bankReserve), playerPayout: Number(payout), netProfit: Number(session.stake - payout) } })
  const updated = await tx.miniGameSession.update({ where: { id: session.id }, data: { status, multiplier: status === 'LOST' ? sessionTerms(session, Math.max(0, opened.length - 1)).multiplier : sessionTerms(session, opened.length).multiplier, openedCells: opened, mineCells: minesField(session.serverSeed!, session.clientSeed!, session.nonce, session.mines!), payout, finishedAt: new Date() } })
  const wallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: session.userId }, select: { balance: true } })
  return { ...view(updated), balance: Number(wallet.balance) }
}
export async function getMinesState(token?: string | null) {
  const id = await userId(token)
  const stale = await prisma.miniGameSession.findFirst({ where: { userId: id, game: 'mines', status: 'ACTIVE', createdAt: { lt: new Date(Date.now() - STALE_SESSION_MS) } } })
  if (stale) {
    await prisma.$transaction(async tx => {
      const locked = await lockedSession(tx, id, stale.id)
      if (locked.status === 'ACTIVE') await finish(tx, locked, 'LOST', openedCells(locked))
    }, { timeout: 15_000 })
  }
  const [active, history] = await Promise.all([
    prisma.miniGameSession.findFirst({ where: { userId: id, game: 'mines', status: 'ACTIVE' } }),
    prisma.miniGameSession.findMany({ where: { userId: id, game: 'mines', status: { not: 'ACTIVE' } }, orderBy: { createdAt: 'desc' }, take: 20 })
  ])
  const economy = await prisma.$transaction(tx => getEconomySnapshot(tx))
  const wallet = await prisma.userWallet.findUniqueOrThrow({ where: { userId: id }, select: { balance: true } })
  const balance = Number(wallet.balance)
  return { active: active ? { ...view(active), balance } : null, history: history.map(view), balance, minStake: 1, maxStake: balance, allowedMines: MINES_COUNT, rtp: 94, economy }
}
export async function prepareMines(token?: string | null) {
  const id = await userId(token)
  const serverSeed = randomBytes(32).toString('hex')
  const commitment = await prisma.minesCommitment.create({ data: { userId: id, serverSeed, seedHash: seedHash(serverSeed), expiresAt: new Date(Date.now() + 15 * 60_000) } })
  return { commitmentId: commitment.id, serverSeedHash: commitment.seedHash, expiresAt: commitment.expiresAt.toISOString() }
}
export async function startMines(token: string | null | undefined, input: MinesStartInput) {
  const id = await userId(token)
  const parsed = minesStartInputSchema.safeParse(input)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    const statusMessage = field === 'stake' ? 'Введите корректную сумму ставки' : field === 'mines' ? 'Проверьте количество мин' : 'Некорректные параметры игры'
    throw createError({ statusCode: 400, statusMessage })
  }
  input = parsed.data
  const bankId = await bankUser()
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
    await lockUsers(tx, [id, bankId])
    const key = `mines:start:${id}:${input.idempotencyKey}`
    const duplicate = await tx.miniGameSession.findUnique({ where: { idempotencyKey: key } })
    if (duplicate) {
      if (duplicate.stake !== BigInt(input.stake) || duplicate.mines !== input.mines || duplicate.clientSeed !== input.clientSeed) throw createError({ statusCode: 409, statusMessage: 'Повторный запрос изменён' })
      const wallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: id }, select: { balance: true } })
      return { session: { ...view(duplicate), balance: Number(wallet.balance) } }
    }
    const stake = BigInt(input.stake)
    const playerWallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: id } })
    if (playerWallet.balance < stake) throw createError({ statusCode: 409, statusMessage: 'Недостаточно фишек' })
    if (await tx.miniGameSession.count({ where: { userId: id, game: 'mines', status: 'ACTIVE' } })) throw createError({ statusCode: 409, statusMessage: 'Сначала завершите текущую игру' })
    const commitment = await tx.minesCommitment.findFirst({ where: { id: input.commitmentId, userId: id, consumedAt: null, expiresAt: { gt: new Date() } } })
    if (!commitment) throw createError({ statusCode: 409, statusMessage: 'Подготовьте новое поле: срок проверки истёк' })
    const theoreticalMaxPayout = minesLimit(stake, input.mines)
    const maxPayout = theoreticalMaxPayout
    // Move the full potential liability out of the bank wallet before the
    // session becomes active. This preserves the wallet/ledger total and
    // rejects insufficient coverage before the player's stake is debited.
    const reserve = maxPayout
    await tx.minesCommitment.update({ where: { id: commitment.id }, data: { consumedAt: new Date() } })
    const session = await tx.miniGameSession.create({ data: { userId: id, game: 'mines', status: 'ACTIVE', stake, mines: input.mines, serverSeed: commitment.serverSeed, serverSeedHash: commitment.seedHash, clientSeed: input.clientSeed, idempotencyKey: key, openedCells: [], multiplier: 1, bankUserId: bankId, bankReserve: reserve, maxPayout } })
    await adjustUserWallet(tx, { userId: id, delta: -stake, entryType: 'MINES_STAKE', transferId: session.id, idempotencyKey: `mines:stake:${session.id}`, metadata: { sessionId: session.id, mines: input.mines } })
    if (reserve > 0n) await adjustUserWallet(tx, { userId: bankId, delta: -reserve, entryType: 'MINES_BANK_RESERVE', transferId: session.id, idempotencyKey: `mines:bank-reserve:${session.id}`, metadata: { sessionId: session.id, maxPayout: Number(maxPayout) } })
    const wallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: id }, select: { balance: true } })
    return { session: { ...view(session), balance: Number(wallet.balance) } }
  }, { timeout: 15_000 })
}
export async function openMinesCell(token: string | undefined | null, sessionId: string, cell: number) {
  const id = await userId(token)
  if (!Number.isInteger(cell) || cell < 0 || cell >= 25) throw createError({ statusCode: 400, statusMessage: 'Некорректная клетка' })
  return prisma.$transaction(async tx => {
    const session = await lockedSession(tx, id, sessionId)
    const opened = openedCells(session)
    if (opened.includes(cell)) return view(session)
    if (session.status !== 'ACTIVE') throw createError({ statusCode: 409, statusMessage: 'Игра уже завершена' })
    const next = [...opened, cell]
    if (minesField(session.serverSeed!, session.clientSeed!, session.nonce, session.mines!).includes(cell)) return finish(tx, session, 'LOST', next)
    const terms = sessionTerms(session, next.length)
    if (next.length === 25 - session.mines! || terms.capped) return finish(tx, session, 'CASHED_OUT', next)
    const updated = await tx.miniGameSession.update({ where: { id: session.id }, data: { openedCells: next, multiplier: terms.multiplier } })
    const wallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: id }, select: { balance: true } })
    return { ...view(updated), balance: Number(wallet.balance) }
  }, { timeout: 15_000 })
}
export async function cashoutMines(token: string | undefined | null, sessionId: string) {
  const id = await userId(token)
  return prisma.$transaction(async tx => {
    const session = await lockedSession(tx, id, sessionId)
    if (session.status === 'CASHED_OUT') return view(session)
    if (session.status !== 'ACTIVE') throw createError({ statusCode: 409, statusMessage: 'Игра уже завершена' })
    const opened = openedCells(session)
    if (!opened.length) throw createError({ statusCode: 409, statusMessage: 'Откройте хотя бы одну клетку' })
    return finish(tx, session, 'CASHED_OUT', opened)
  }, { timeout: 15_000 })
}
export async function verifyMines(token: string | null | undefined, sessionId: string) {
  const id = await userId(token)
  const session = await prisma.miniGameSession.findFirst({ where: { id: sessionId, userId: id, game: 'mines', status: { not: 'ACTIVE' } } })
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Доступна проверка только завершённой игры' })
  const opened = openedCells(session)
  const legacy = session.createdAt < LEGACY_MINES_CUTOFF
  const field = legacy ? legacyMinesField(session.serverSeed!, session.clientSeed!, session.nonce, session.mines!) : minesField(session.serverSeed!, session.clientSeed!, session.nonce, session.mines!)
  return { ...view(session), verified: seedHash(session.serverSeed!) === session.serverSeedHash && JSON.stringify(field) === JSON.stringify(session.mineCells), algorithm: 'hmac-sha256-columns-v2', explanation: 'Поле состоит из 5 столбцов. В каждом столбце HMAC-SHA256 выбирает одинаковое число мин из 5 клеток; SHA256(seed) совпадает с хешем до ставки.' }
}
