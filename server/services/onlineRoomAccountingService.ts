import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { adjustUserWallet } from './walletService'

const ONLINE_BUY_IN = 'ONLINE_POKER_BUY_IN'
const ONLINE_CASH_OUT = 'ONLINE_POKER_CASH_OUT'
const ONLINE_BUY_IN_REFUND = 'ONLINE_POKER_BUY_IN_REFUND'
const ONLINE_STACK_ADD = 'ONLINE_POKER_STACK_ADD'
const ONLINE_STACK_WITHDRAW = 'ONLINE_POKER_STACK_WITHDRAW'

type AccountingStatus = 'RESERVING' | 'ACTIVE' | 'CASH_OUT_PENDING' | 'CASHED_OUT'
export type OnlineStackOperationDirection = 'ADD' | 'WITHDRAW'
export type OnlineStackOperation = Readonly<{
  id: string
  roomId: string
  userId: string
  reservationId: string
  requestKey: string
  direction: OnlineStackOperationDirection
  amount: bigint
  stackBefore: bigint
  stackAfter: bigint
  status: 'PREPARED' | 'RUNTIME_APPLIED' | 'COMPLETED'
}>

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
export async function lockOnlineFundsTransition(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('season-transition', 0))::text`
}

const lockSeasonTransition = lockOnlineFundsTransition

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
export async function prepareOnlineCashOut(input: Readonly<{ roomId: string; userId: string; amount: number; readAuthoritativeAmount?: () => Promise<number | null> }>): Promise<boolean> {
  safeAmount(input.amount, 'Online cash-out', true)
  if (!isAccountUserId(input.userId)) return false
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId, true)
    const row = await lockPlayer(tx, input.roomId, input.userId)
    if (!row || row.status === 'CASHED_OUT') return false
    if (await tx.onlineStackOperation.count({ where: { roomId: input.roomId, status: { not: 'COMPLETED' } } })) {
      throw Object.assign(new Error('A stack operation is still being completed.'), { code: 'STACK_OPERATION_PENDING' })
    }
    if (row.status === 'CASH_OUT_PENDING') return true
    const amount = input.readAuthoritativeAmount ? await input.readAuthoritativeAmount() : input.amount
    if (amount === null) throw Object.assign(new Error('The player is no longer seated in this room.'), { code: 'STACK_SEAT_UNAVAILABLE' })
    safeAmount(amount, 'Online cash-out', true)
    await tx.onlineRoomPlayer.update({ where: { id: row.id }, data: { status: 'CASH_OUT_PENDING', cashOutPending: BigInt(amount) } })
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
    if (await tx.onlineStackOperation.count({ where: { roomId: input.roomId, status: { not: 'COMPLETED' } } })) {
      throw Object.assign(new Error('A stack operation is still being completed.'), { code: 'STACK_OPERATION_PENDING' })
    }
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

/** Persists the DB half (and, for ADD, wallet debit) before any Redis mutation. */
export async function prepareOnlineStackOperation(input: Readonly<{
  roomId: string
  userId: string
  requestKey: string
  direction: OnlineStackOperationDirection
  amount: number
  readRuntime: () => Promise<Readonly<{ stack: number | null; activeHand: boolean }>>
}>): Promise<OnlineStackOperation> {
  safeAmount(input.amount, 'Stack operation')
  if (!isAccountUserId(input.userId)) throw Object.assign(new Error('An account-backed player is required.'), { code: 'INVALID_USER' })
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, input.roomId)
    const existingRequest = await tx.onlineStackOperation.findUnique({
      where: { roomId_userId_requestKey: { roomId: input.roomId, userId: input.userId, requestKey: input.requestKey } }
    })
    if (existingRequest) {
      if (existingRequest.direction !== input.direction || existingRequest.amount !== BigInt(input.amount)) {
        throw Object.assign(new Error('The operation key was already used with a different request.'), { code: 'STACK_OPERATION_CONFLICT' })
      }
      return existingRequest as OnlineStackOperation
    }
    const pending = await tx.onlineStackOperation.findFirst({ where: { roomId: input.roomId, userId: input.userId, status: { not: 'COMPLETED' } } })
    if (pending) throw Object.assign(new Error('A previous stack operation is still being completed.'), { code: 'STACK_OPERATION_PENDING' })
    const reservation = await lockPlayer(tx, input.roomId, input.userId)
    if (!reservation || reservation.status !== 'ACTIVE') {
      throw Object.assign(new Error('The authenticated user has no active funded seat in this room.'), { code: 'STACK_SEAT_UNAVAILABLE' })
    }
    const runtime = await input.readRuntime()
    if (runtime.activeHand) throw Object.assign(new Error('Нельзя изменить стек во время раздачи.'), { code: 'HAND_IN_PROGRESS' })
    if (runtime.stack === null) throw Object.assign(new Error('The authenticated user is not seated in this room.'), { code: 'STACK_SEAT_UNAVAILABLE' })
    const stackAfter = input.direction === 'ADD' ? runtime.stack + input.amount : runtime.stack - input.amount
    if (!Number.isSafeInteger(stackAfter) || stackAfter <= 0) {
      const code = input.direction === 'WITHDRAW' && runtime.stack === input.amount ? 'FULL_STACK_WITHDRAWAL' : 'STACK_AMOUNT_UNAVAILABLE'
      throw Object.assign(new Error(code === 'FULL_STACK_WITHDRAWAL'
        ? 'Чтобы вывести весь стек, используйте «Выйти из комнаты».'
        : 'Сумма превышает доступный стек.'), { code })
    }
    const sequence = reservation.buyInSequence
    if (input.direction === 'ADD') {
      await adjustUserWallet(tx, {
        userId: input.userId,
        delta: -BigInt(input.amount),
        entryType: ONLINE_STACK_ADD,
        idempotencyKey: `online-stack-add:${input.roomId}:${input.userId}:${input.requestKey}`,
        metadata: { onlineRoomId: input.roomId, playerId: input.userId, requestKey: input.requestKey, amount: input.amount }
      })
      await tx.onlineRoomPlayer.update({ where: { id: reservation.id }, data: { buyIn: { increment: BigInt(input.amount) } } })
    }
    return tx.onlineStackOperation.create({ data: {
      roomId: input.roomId,
      userId: input.userId,
      reservationId: reservation.id,
      requestKey: input.requestKey,
      direction: input.direction,
      amount: BigInt(input.amount),
      stackBefore: BigInt(runtime.stack),
      stackAfter: BigInt(stackAfter),
      status: 'PREPARED'
    } }) as Promise<OnlineStackOperation>
  })
}

/** Locks room + operation while applying the idempotent Redis CAS. */
export async function applyOnlineStackOperation<T>(input: Readonly<{
  operationId: string
  applyRuntime: (operation: OnlineStackOperation) => Promise<T>
}>): Promise<Readonly<{ operation: OnlineStackOperation; result: T; duplicate: boolean }>> {
  return prisma.$transaction(async tx => {
    const operationHead = await tx.onlineStackOperation.findUnique({ where: { id: input.operationId } })
    if (!operationHead) throw Object.assign(new Error('Stack operation was not found.'), { code: 'STACK_OPERATION_NOT_FOUND' })
    await lockSeasonTransition(tx)
    await lockRoom(tx, operationHead.roomId)
    await tx.$queryRaw`SELECT id FROM "online_stack_operations" WHERE id = CAST(${input.operationId} AS uuid) FOR UPDATE`
    const operation = await tx.onlineStackOperation.findUniqueOrThrow({ where: { id: input.operationId } }) as OnlineStackOperation
    if (operation.status === 'COMPLETED') return Object.freeze({ operation, result: undefined as T, duplicate: true })
    const result = await input.applyRuntime(operation)
    const updated = await tx.onlineStackOperation.update({ where: { id: operation.id }, data: { status: 'RUNTIME_APPLIED' } }) as OnlineStackOperation
    return Object.freeze({ operation: updated, result, duplicate: false })
  })
}

/** Credits a WITHDRAW only after the stack CAS is durably recorded. */
export async function completeOnlineStackOperation(operationId: string): Promise<OnlineStackOperation> {
  return prisma.$transaction(async tx => {
    const head = await tx.onlineStackOperation.findUnique({ where: { id: operationId } })
    if (!head) throw Object.assign(new Error('Stack operation was not found.'), { code: 'STACK_OPERATION_NOT_FOUND' })
    await lockSeasonTransition(tx)
    await lockRoom(tx, head.roomId)
    await tx.$queryRaw`SELECT id FROM "online_stack_operations" WHERE id = CAST(${operationId} AS uuid) FOR UPDATE`
    const operation = await tx.onlineStackOperation.findUniqueOrThrow({ where: { id: operationId } })
    if (operation.status === 'COMPLETED') return operation as OnlineStackOperation
    if (operation.status !== 'RUNTIME_APPLIED') throw Object.assign(new Error('Stack operation runtime change is not confirmed.'), { code: 'STACK_OPERATION_NOT_APPLIED' })
    const reservation = await lockPlayer(tx, operation.roomId, operation.userId)
    if (!reservation || reservation.id !== operation.reservationId || !['ACTIVE', 'CASH_OUT_PENDING'].includes(reservation.status)) {
      throw Object.assign(new Error('The funded reservation is no longer available.'), { code: 'STACK_SEAT_UNAVAILABLE' })
    }
    if (operation.direction === 'WITHDRAW') {
      await tx.onlineRoomPlayer.update({ where: { id: reservation.id }, data: { buyIn: { decrement: operation.amount } } })
      await adjustUserWallet(tx, {
        userId: operation.userId,
        delta: operation.amount,
        entryType: ONLINE_STACK_WITHDRAW,
        idempotencyKey: `online-stack-withdraw:${operation.roomId}:${operation.userId}:${operation.requestKey}`,
        metadata: { onlineRoomId: operation.roomId, playerId: operation.userId, requestKey: operation.requestKey, amount: Number(operation.amount) }
      })
    }
    return tx.onlineStackOperation.update({ where: { id: operation.id }, data: { status: 'COMPLETED', completedAt: new Date() } }) as Promise<OnlineStackOperation>
  })
}

export async function pendingOnlineStackOperations(roomId: string): Promise<readonly OnlineStackOperation[]> {
  return prisma.onlineStackOperation.findMany({ where: { roomId, status: { not: 'COMPLETED' } }, orderBy: { createdAt: 'asc' } }) as Promise<readonly OnlineStackOperation[]>
}

export async function lockOnlineRoomHandStart<T>(roomId: string, start: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await lockSeasonTransition(tx)
    await lockRoom(tx, roomId)
    const pending = await tx.onlineStackOperation.findFirst({ where: { roomId, status: { not: 'COMPLETED' } }, select: { id: true } })
    if (pending) throw Object.assign(new Error('Сначала завершается изменение стека. Обновите стол и повторите.'), { code: 'STACK_OPERATION_PENDING' })
    return start()
  })
}

export async function onlineStackWalletBalance(userId: string): Promise<number> {
  const wallet = await prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } })
  if (wallet) return Number(wallet.balance)
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } })
  return Math.max(0, account?.balance ?? 0)
}

export async function pendingOnlineCashOuts(roomId: string): Promise<readonly string[]> {
  const rows = await prisma.onlineRoomPlayer.findMany({ where: { roomId, status: 'CASH_OUT_PENDING' }, select: { userId: true } })
  return rows.map(row => row.userId)
}

export async function pendingOnlineBuyIns(roomId: string): Promise<ReadonlyArray<Readonly<{ userId: string; sequence: number }>>> {
  const rows = await prisma.onlineRoomPlayer.findMany({ where: { roomId, status: 'RESERVING' }, select: { userId: true, buyInSequence: true } })
  return rows.map(row => Object.freeze({ userId: row.userId, sequence: row.buyInSequence }))
}

export const ONLINE_POKER_LEDGER_ENTRY_TYPES = Object.freeze({ BUY_IN: ONLINE_BUY_IN, CASH_OUT: ONLINE_CASH_OUT, STACK_ADD: ONLINE_STACK_ADD, STACK_WITHDRAW: ONLINE_STACK_WITHDRAW })
