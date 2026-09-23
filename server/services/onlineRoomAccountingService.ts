import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { adjustUserWallet } from './walletService'

const ONLINE_BUY_IN = 'ONLINE_POKER_BUY_IN'
const ONLINE_CASH_OUT = 'ONLINE_POKER_CASH_OUT'
const ONLINE_BUY_IN_REFUND = 'ONLINE_POKER_BUY_IN_REFUND'

type AccountingStatus = 'RESERVING' | 'ACTIVE' | 'CASH_OUT_PENDING' | 'CASHED_OUT'

export type OnlineBuyInReservation = Readonly<{
  accounted: boolean
  status: AccountingStatus
  sequence: number
  amount: number
  seat: number
}>

/**
 * HTTP authentication always supplies a UUID user id. The non-UUID path keeps
 * the pure runtime service tests usable without a database account; it is not
 * reachable through the authenticated HTTP/WS entry points.
 */
function isAccountUserId(userId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
}

function safeAmount(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${label} must be ${allowZero ? 'non-negative' : 'positive'}.`)
}

function metadata(roomId: string, userId: string, sequence: number, amount: number) {
  return { onlineRoomId: roomId, playerId: userId, buyInSequence: sequence, amount }
}

async function lockRoom(tx: Prisma.TransactionClient, roomId: string, allowClosed = false): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "online_rooms" WHERE id = CAST(${roomId} AS uuid) FOR UPDATE`
  if (rows[0]?.status === 'CLOSED' && !allowClosed) throw Object.assign(new Error('The online room is closed.'), { code: 'ROOM_CLOSED' })
  return rows[0]?.status ?? null
}

/** Serializes all ONLINE wallet transitions with the season wallet reset. */
async function lockSeasonTransition(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
}

async function lockPlayer(tx: Prisma.TransactionClient, roomId: string, userId: string) {
  return tx.onlineRoomPlayer.findUnique({ where: { roomId_userId: { roomId, userId } } })
}

/** Reserves the authoritative room buy-in exactly once for a room/user cycle. */
async function reserveOnlineBuyInInternal(input: Readonly<{ roomId: string; userId: string; seat: number; amount: number }>, allowClosed = false): Promise<OnlineBuyInReservation> {
  safeAmount(input.amount, 'Online buy-in')
  safeAmount(input.seat, 'Online seat')
  if (!isAccountUserId(input.userId)) return Object.freeze({ accounted: false, status: 'ACTIVE', sequence: 0, amount: input.amount, seat: input.seat })

  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, allowClosed)
    const existing = await lockPlayer(tx, input.roomId, input.userId)
    if (existing && (existing.status === 'ACTIVE' || existing.status === 'RESERVING')) {
      if (Number(existing.buyIn) !== input.amount) throw new Error('The online room buy-in does not match the existing reservation.')
      return Object.freeze({ accounted: true, status: existing.status as AccountingStatus, sequence: existing.buyInSequence, amount: Number(existing.buyIn), seat: existing.seat })
    }
    if (existing?.status === 'CASH_OUT_PENDING') throw new Error('The previous online cash-out is still being completed.')

    const sequence = existing ? existing.buyInSequence + 1 : 0
    const key = `online-buyin:${input.roomId}:${input.userId}:${sequence}`
    await adjustUserWallet(tx, {
      userId: input.userId,
      delta: -BigInt(input.amount),
      entryType: ONLINE_BUY_IN,
      idempotencyKey: key,
      metadata: metadata(input.roomId, input.userId, sequence, input.amount)
    })
    const row = existing
      ? await tx.onlineRoomPlayer.update({
          where: { id: existing.id },
          data: { seat: input.seat, buyIn: BigInt(input.amount), status: 'RESERVING', cashOutPending: null, buyInSequence: sequence, cashedOutAt: null }
        })
      : await tx.onlineRoomPlayer.create({
          data: { roomId: input.roomId, userId: input.userId, seat: input.seat, buyIn: BigInt(input.amount), status: 'RESERVING', buyInSequence: sequence }
        })
    return Object.freeze({ accounted: true, status: row.status as AccountingStatus, sequence, amount: Number(row.buyIn), seat: row.seat })
  })
}

/** Used only by the creator path after it has inserted CLOSED metadata and before runtime publication. */
export function reserveInitialOnlineRoomBuyIn(input: Readonly<{ roomId: string; userId: string; seat: number; amount: number }>): Promise<OnlineBuyInReservation> {
  return reserveOnlineBuyInInternal(input, true)
}

/** Reserves the authoritative room buy-in exactly once for a room/user cycle. */
export function reserveOnlineBuyIn(input: Readonly<{ roomId: string; userId: string; seat: number; amount: number }>): Promise<OnlineBuyInReservation> {
  return reserveOnlineBuyInInternal(input)
}

/** Holds the room/season accounting locks across Redis CAS and activates only after CAS succeeds. */
export async function commitOnlineBuyInSeat<T>(input: Readonly<{ roomId: string; userId: string; sequence: number; seat: number; allowClosed?: boolean }>, mutateRuntime: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    if (!isAccountUserId(input.userId)) return mutateRuntime(tx)
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, input.allowClosed)
    const row = await lockPlayer(tx, input.roomId, input.userId)
    if (!row || row.buyInSequence !== input.sequence || !['RESERVING', 'ACTIVE'].includes(row.status)) {
      throw Object.assign(new Error('Online buy-in reservation is no longer active.'), { code: 'BUY_IN_UNAVAILABLE' })
    }
    if (row.status === 'ACTIVE') throw Object.assign(new Error('Online seat is already committed.'), { code: 'ALREADY_SEATED' })
    const result = await mutateRuntime(tx)
    const changed = await tx.onlineRoomPlayer.updateMany({
      where: { id: row.id, status: 'RESERVING', buyInSequence: input.sequence },
      data: { status: 'ACTIVE', seat: input.seat }
    })
    if (changed.count !== 1) throw Object.assign(new Error('Online buy-in reservation changed during seating.'), { code: 'BUY_IN_UNAVAILABLE' })
    return result
  })
}

/** Reconciles one reservation while holding its room/season accounting locks across the authoritative Redis read. */
export async function reconcileOnlineBuyIn(input: Readonly<{ roomId: string; userId: string; sequence: number }>, readSeat: () => Promise<number | null>): Promise<'ACTIVE' | 'REFUNDED' | 'UNCHANGED'> {
  if (!isAccountUserId(input.userId)) return 'UNCHANGED'
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    const roomStatus = await lockRoom(tx, input.roomId, true)
    const row = await lockPlayer(tx, input.roomId, input.userId)
    if (!row || row.buyInSequence !== input.sequence || row.status !== 'RESERVING') return 'UNCHANGED'
    const seat = await readSeat()
    if (seat !== null) {
      if (seat !== row.seat) throw Object.assign(new Error('Online reservation seat does not match the authoritative runtime.'), { code: 'BUY_IN_UNAVAILABLE' })
      await tx.onlineRoomPlayer.update({ where: { id: row.id }, data: { status: 'ACTIVE', seat } })
      // CLOSED is also the creator's staging state. A surviving authoritative
      // owner seat proves room publication completed before the process died.
      if (roomStatus === 'CLOSED') await tx.onlineRoom.updateMany({ where: { id: input.roomId, status: 'CLOSED' }, data: { status: 'WAITING' } })
      return 'ACTIVE'
    }
    await adjustUserWallet(tx, {
      userId: input.userId,
      delta: row.buyIn,
      entryType: ONLINE_BUY_IN_REFUND,
      idempotencyKey: `online-buyin-refund:${input.roomId}:${input.userId}:${input.sequence}`,
      metadata: metadata(input.roomId, input.userId, input.sequence, Number(row.buyIn))
    })
    await tx.onlineRoomPlayer.update({ where: { id: row.id }, data: { status: 'CASHED_OUT', cashOutPending: null, cashedOutAt: new Date() } })
    return 'REFUNDED'
  })
}

/** Marks a seat's current stack for a later, exactly-once cash-out. */
export async function prepareOnlineCashOut(input: Readonly<{ roomId: string; userId: string; amount: number }>): Promise<boolean> {
  safeAmount(input.amount, 'Online cash-out', true)
  if (!isAccountUserId(input.userId)) return false
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, true)
    const row = await lockPlayer(tx, input.roomId, input.userId)
    if (!row || row.status === 'CASHED_OUT') return false
    if (row.status === 'CASH_OUT_PENDING') return true
    await tx.onlineRoomPlayer.update({ where: { id: row.id }, data: { status: 'CASH_OUT_PENDING', cashOutPending: BigInt(input.amount) } })
    return true
  })
}

export async function clearOnlineCashOut(input: Readonly<{ roomId: string; userId: string }>): Promise<void> {
  if (!isAccountUserId(input.userId)) return
  await prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, true)
    await tx.onlineRoomPlayer.updateMany({
      where: { roomId: input.roomId, userId: input.userId, status: 'CASH_OUT_PENDING' },
      data: { status: 'ACTIVE', cashOutPending: null }
    })
  })
}

export async function completeOnlineCashOut(input: Readonly<{ roomId: string; userId: string }>): Promise<boolean> {
  if (!isAccountUserId(input.userId)) return false
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, true)
    const row = await lockPlayer(tx, input.roomId, input.userId)
    if (!row || row.status === 'CASHED_OUT') return false
    if (row.status !== 'CASH_OUT_PENDING' || row.cashOutPending === null) return false
    const amount = row.cashOutPending
    if (amount > 0n) {
      await adjustUserWallet(tx, {
        userId: input.userId,
        delta: amount,
        entryType: ONLINE_CASH_OUT,
        idempotencyKey: `online-cashout:${input.roomId}:${input.userId}:${row.buyInSequence}`,
        metadata: metadata(input.roomId, input.userId, row.buyInSequence, Number(amount))
      })
    }
    await tx.onlineRoomPlayer.update({ where: { id: row.id }, data: { status: 'CASHED_OUT', cashOutPending: null, cashedOutAt: new Date() } })
    return true
  })
}

export async function pendingOnlineCashOuts(roomId: string): Promise<readonly string[]> {
  const rows = await prisma.onlineRoomPlayer.findMany({ where: { roomId, status: 'CASH_OUT_PENDING' }, select: { userId: true } })
  return rows.map(row => row.userId)
}

export async function pendingOnlineBuyIns(roomId: string): Promise<ReadonlyArray<Readonly<{ userId: string; sequence: number }>>> {
  const rows = await prisma.onlineRoomPlayer.findMany({ where: { roomId, status: 'RESERVING' }, select: { userId: true, buyInSequence: true } })
  return rows.map(row => Object.freeze({ userId: row.userId, sequence: row.buyInSequence }))
}

export const ONLINE_POKER_LEDGER_ENTRY_TYPES = Object.freeze({ BUY_IN: ONLINE_BUY_IN, CASH_OUT: ONLINE_CASH_OUT })
