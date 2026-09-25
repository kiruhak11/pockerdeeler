import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { prisma } from '../db/client'
import {
  applyOnlineRoomAction,
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  setOnlineRoomReady,
  setOnlineRoomSittingOut,
  setOnlineRoomConnected,
  setOnlineRoomTurnDeadline,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState,
  type ApplyOnlineRoomActionOptions,
  OnlineRoomError,
  type OnlineRoomState
} from '../utils/pokerOnlineRoom'
import { PokerTableError, advanceTableStreet, canStartNextHand, finalizeTableHand } from '../utils/pokerTableState'
import { getLegalBettingActions, getMinimumRaiseTo, getToCall } from '../utils/pokerBetting'
import {
  getOnlineRoomTurnTimerService,
  ONLINE_ROOM_TURN_TIMEOUT_MS,
  type OnlineRoomTurnTimerJob,
  type OnlineRoomTurnTimerService
} from './onlineRoomTurnTimerService'
import { hashSecret, verifySecret } from './authService'
import {
  createPersistentOnlineRoom,
  normalizeGlobalRoomCode,
  resolveRoomCode
} from './roomCodeRegistryService'
import {
  OnlineRoomRuntimeStore,
  OnlineRoomRuntimeStoreError,
  type OnlineRoomRuntimeRecord,
  type OnlineRoomMutationFence
} from './onlineRoomRuntimeStore'
import { publishOnlineRoomChanged } from './onlineRoomRealtimeService'
import { OnlineRoomPresenceError } from './onlineRoomPresenceService'
import { isDatabaseUnavailableError } from '../utils/databaseErrors'
import { resolveRoomSecretPepper } from '../utils/roomSecretPepper'
import {
  commitOnlineBuyInSeat,
  clearOnlineCashOut,
  completeOnlineCashOut,
  pendingOnlineCashOuts,
  pendingOnlineBuyIns,
  reconcileOnlineBuyIn,
  prepareOnlineCashOut,
  reserveOnlineBuyIn,
  reserveInitialOnlineRoomBuyIn,
  type OnlineBuyInReservation
} from './onlineRoomAccountingService'
import { assertOnlinePokerBotMayJoin, OnlinePokerBotJoinError } from './botIdentityService'
import { recordFinalizedOnlinePokerHand } from './onlinePokerRatingService'

const DEFAULT_OWNER_STACK = 1_000
const DEFAULT_SMALL_BLIND = 5
const DEFAULT_BIG_BLIND = 10
const TOKEN_VERSION = 1

export type OnlineRoomApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CLOSED'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'STALE_STATE'
  | 'NOT_YOUR_TURN'
  | 'INVALID_ACTION'
  | 'HAND_NOT_ACTIVE'
  | 'ACTION_CONFLICT'

export class OnlineRoomApiError extends Error {
  readonly code: OnlineRoomApiErrorCode
  readonly statusCode: number

  constructor(code: OnlineRoomApiErrorCode, message: string, statusCode: number) {
    super(message)
    this.name = 'OnlineRoomApiError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fail(code: OnlineRoomApiErrorCode, message: string, statusCode: number): never {
  throw new OnlineRoomApiError(code, message, statusCode)
}

export type OnlineRoomApiDependencies = Readonly<{
  runtime?: OnlineRoomRuntimeStore
  timer?: OnlineRoomTurnTimerService
  /** Internal-only fencing data for autonomous bot mutations. Never accepted from HTTP/WS. */
  botFence?: OnlineRoomMutationFence
}>

export type CreateAuthenticatedOnlineRoomInput = Readonly<{
  visibility?: 'PUBLIC' | 'PRIVATE'
  startingStack?: number
  smallBlind?: number
  bigBlind?: number
  ownerSeat?: number
  privateJoinSecret?: string
}>

export type OnlineRoomConcurrencyInput = Readonly<{
  concurrencyToken: string
  expectedRoomVersion?: number
}>

export type JoinAuthenticatedOnlineRoomInput = Partial<OnlineRoomConcurrencyInput> & Readonly<{
  seat?: number
  joinSecret?: string
}>

export type OnlineRoomLobbyEntry = Readonly<{
  code: string
  playerCount: number
  maxPlayers: 6
  status: 'WAITING' | 'IN_HAND'
  createdAt: string
  startingStack: number
  smallBlind: number
  bigBlind: number
}>

export type OnlinePokerBotDecisionSnapshot = Readonly<{
  room: ApiOnlineRoomResult['room']
  legalActions: ReturnType<typeof getLegalBettingActions>
  toCall: number
  minRaiseTo: number
  raiseReopened: boolean
}>

export type ReadyAuthenticatedOnlineRoomInput = OnlineRoomConcurrencyInput & Readonly<{
  ready: boolean
}>

export type SittingOutAuthenticatedOnlineRoomInput = OnlineRoomConcurrencyInput & Readonly<{
  sittingOut: boolean
}>

export type AuthenticatedOnlineRoomActionInput = Readonly<{
  actionId: string
  expectedTableStateVersion: number
  action: Pick<ApplyOnlineRoomActionOptions['action'], 'type' | 'amount'>
}>

export type AuthenticatedOnlineRoomActionResult = Readonly<ApiOnlineRoomResult & {
  duplicate: boolean
}>

export type ApiOnlineRoomResult = Readonly<{
  room: ReturnType<typeof toPlayerSafeOnlineRoomState>
  concurrencyToken: string
}>

type SafeOnlineRoomState = ReturnType<typeof toPlayerSafeOnlineRoomState>
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fallbackPlayerNickname(seat: number): string {
  return `Игрок ${seat}`
}

/** Adds only public profile names to an already player-safe room snapshot. */
async function addPublicPlayerNicknames(room: SafeOnlineRoomState): Promise<SafeOnlineRoomState> {
  const ids = new Set<string>(room.pokerTable.players.map(player => player.playerId))
  for (const player of room.pokerTable.currentHand?.players ?? []) ids.add(player.playerId)
  for (const player of room.pokerTable.finalizedHand?.players ?? []) ids.add(player.playerId)
  const userIds = [...ids].filter(id => UUID_PATTERN.test(id))
  const names = new Map<string, string>()
  if (userIds.length > 0) {
    try {
      const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
      for (const user of users) {
        if (typeof user.username === 'string' && user.username.trim()) names.set(user.id, user.username)
      }
    } catch {
      // A profile read is presentation metadata; the safe seat fallback remains valid.
    }
  }
  const players = Object.freeze(room.pokerTable.players.map(player => Object.freeze({
    ...player,
    nickname: names.get(player.playerId) ?? fallbackPlayerNickname(player.seat)
  })))
  const currentHand = room.pokerTable.currentHand
  const finalizedHand = room.pokerTable.finalizedHand
  const handPlayers = currentHand
    ? Object.freeze(currentHand.players.map(player => Object.freeze({
      ...player,
      nickname: names.get(player.playerId) ?? fallbackPlayerNickname(player.seat)
    })))
    : null
  const finalizedPlayers = finalizedHand
    ? Object.freeze(finalizedHand.players.map(player => Object.freeze({
      ...player,
      nickname: names.get(player.playerId) ?? fallbackPlayerNickname(player.seat)
    })))
    : null
  return Object.freeze({
    ...room,
    pokerTable: Object.freeze({
      ...room.pokerTable,
      players,
      ...(currentHand ? { currentHand: Object.freeze({ ...currentHand, players: handPlayers! }) } : {}),
      ...(finalizedHand ? { finalizedHand: Object.freeze({ ...finalizedHand, players: finalizedPlayers! }) } : {})
    })
  })
}

async function safeOnlineRoomState(state: OnlineRoomState, viewerId: string | undefined): Promise<SafeOnlineRoomState> {
  return addPublicPlayerNicknames(toPlayerSafeOnlineRoomState(state, viewerId))
}

async function safeOnlineRoomResult(state: OnlineRoomState, viewerId: string | undefined, runtimeRevision: number): Promise<ApiOnlineRoomResult> {
  return Object.freeze({
    room: await safeOnlineRoomState(state, viewerId),
    concurrencyToken: issueConcurrencyToken(state.roomId, runtimeRevision)
  })
}

type PersistentRoom = Readonly<{
  id: string
  roomCode: string
  visibility: 'PUBLIC' | 'PRIVATE'
  ownerId: string
  status: 'WAITING' | 'CLOSED'
  maxPlayers: 6
  privateJoinSecretHash: string | null
  startingStack: number
  createdAt: Date
}>

let defaultRuntime: OnlineRoomRuntimeStore | undefined

function runtimeStore(dependencies?: OnlineRoomApiDependencies): OnlineRoomRuntimeStore {
  if (dependencies?.runtime) return dependencies.runtime
  return (defaultRuntime ??= new OnlineRoomRuntimeStore())
}

function timerStore(dependencies?: OnlineRoomApiDependencies): OnlineRoomTurnTimerService {
  if (dependencies?.timer) return dependencies.timer
  return getOnlineRoomTurnTimerService()
}

function assertTableStateVersion(room: OnlineRoomState, expectedTableStateVersion: number | undefined): void {
  if (expectedTableStateVersion === undefined) return
  if (!Number.isSafeInteger(expectedTableStateVersion) || expectedTableStateVersion !== room.pokerTable.stateVersion) {
    throw new PokerTableError('STALE_STATE_VERSION', `Expected table state version ${String(expectedTableStateVersion)} does not match ${room.pokerTable.stateVersion}.`)
  }
}

function advanceCompletedStreet(room: OnlineRoomState, expectedTableStateVersion?: number): OnlineRoomState {
  assertTableStateVersion(room, expectedTableStateVersion)
  const hand = room.pokerTable.currentHand
  if (!hand) return room
  if (hand.street === 'SHOWDOWN' || hand.street === 'FINISHED') {
    if (room.pokerTable.finalizedHandId === hand.handId) return room
    const pokerTable = finalizeTableHand(room.pokerTable)
    return Object.freeze({
      ...room,
      pokerTable,
      status: 'WAITING' as const,
      turnDeadlineAt: null
    })
  }
  if (!hand.bettingRoundComplete) return room
  let pokerTable = advanceTableStreet(room.pokerTable, expectedTableStateVersion)
  const advancedHand = pokerTable.currentHand
  if (advancedHand && (advancedHand.street === 'SHOWDOWN' || advancedHand.street === 'FINISHED')) {
    pokerTable = finalizeTableHand(pokerTable)
  }
  return Object.freeze({
    ...room,
    pokerTable,
    status: pokerTable.status === 'WAITING' ? 'WAITING' as const : 'IN_HAND' as const
  })
}

function nextTurnDeadline(room: OnlineRoomState, now = Date.now()): number | null {
  const hand = room.pokerTable.currentHand
  if (!hand || hand.street === 'SHOWDOWN' || hand.street === 'FINISHED' || hand.bettingRoundComplete || hand.currentActor === null) return null
  const actor = hand.players.find(player => player.seat === hand.currentActor)
  if (!actor || actor.status !== 'ACTIVE' || actor.stack <= 0) return null
  return now + ONLINE_ROOM_TURN_TIMEOUT_MS
}

function withNextTurnDeadline(room: OnlineRoomState, now = Date.now()): OnlineRoomState {
  return setOnlineRoomTurnDeadline(room, nextTurnDeadline(room, now))
}

function timerJobFromSafeResult(result: ApiOnlineRoomResult, runtimeRevision?: number): Omit<OnlineRoomTurnTimerJob, 'jobId'> | null {
  const hand = result.room.pokerTable.currentHand
  const deadlineAt = hand?.turnDeadlineAt ?? null
  if (!hand || deadlineAt === null || hand.currentActor === null || hand.street === 'SHOWDOWN' || hand.street === 'FINISHED' || hand.bettingRoundComplete) return null
  const actor = hand.players.find(player => player.seat === hand.currentActor)
  if (!actor || actor.status !== 'ACTIVE' || actor.stack <= 0) return null
  return {
    roomId: result.room.roomId,
    roomCode: result.room.roomCode,
    playerId: actor.playerId,
    expectedTableStateVersion: result.room.pokerTable.stateVersion,
    handId: hand.handId,
    street: hand.street,
    deadlineAt,
    ...(runtimeRevision === undefined ? {} : { runtimeRevision })
  }
}

async function reconcileTurnTimer(result: ApiOnlineRoomResult, dependencies?: OnlineRoomApiDependencies, runtimeRevision?: number): Promise<void> {
  const timer = timerStore(dependencies)
  const job = timerJobFromSafeResult(result, runtimeRevision)
  if (!job) {
    await timer.clear(result.room.roomId)
    return
  }
  timer.start(jobToProcessor(dependencies))
  await timer.schedule(job)
}

function jobToProcessor(dependencies?: OnlineRoomApiDependencies) {
  return async (job: OnlineRoomTurnTimerJob) => processAuthenticatedOnlineRoomTimeout(job, dependencies)
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail('BAD_REQUEST', `${label} must be an integer between ${min} and ${max}.`, 400)
  }
  return value as number
}

function requireUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.trim().length === 0) fail('UNAUTHORIZED', 'Authenticated user is required.', 401)
}

function cryptoKey(): Buffer {
  return createHash('sha256').update(resolveRoomSecretPepper()).digest()
}

/** Opaque, authenticated concurrency token; the Redis revision is never sent as a field. */
function issueConcurrencyToken(roomId: string, revision: number): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cryptoKey(), iv)
  const plaintext = JSON.stringify({ v: TOKEN_VERSION, roomId, revision })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function expectedRevision(roomId: string, token: string): number {
  if (typeof token !== 'string' || token.length < 32) fail('CONFLICT', 'A current room concurrency token is required.', 409)
  try {
    const encoded = Buffer.from(token, 'base64url')
    if (encoded.length <= 28) throw new Error('Invalid token.')
    const decipher = createDecipheriv('aes-256-gcm', cryptoKey(), encoded.subarray(0, 12))
    decipher.setAuthTag(encoded.subarray(12, 28))
    const payload = JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')) as Record<string, unknown>
    if (payload.v !== TOKEN_VERSION || payload.roomId !== roomId || !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 1) throw new Error('Invalid token.')
    return payload.revision as number
  } catch {
    fail('CONFLICT', 'The room concurrency token is invalid or stale.', 409)
  }
}

function mapRuntimeError(error: unknown): OnlineRoomApiError {
  if (error instanceof OnlineRoomApiError) return error
  if (error instanceof OnlineRoomRuntimeStoreError) {
    if (error.code === 'STALE_STATE') return new OnlineRoomApiError('CONFLICT', 'The room changed. Refresh and retry the action.', 409)
    if (error.code === 'ACTION_CONFLICT') return new OnlineRoomApiError('ACTION_CONFLICT', 'This action id was already used with a different payload.', 409)
    if (error.code === 'ROOM_NOT_FOUND') return new OnlineRoomApiError('UNAVAILABLE', 'Online room runtime is unavailable.', 503)
    return new OnlineRoomApiError('UNAVAILABLE', 'Online room runtime is temporarily unavailable.', 503)
  }
  if (error instanceof OnlineRoomPresenceError) {
    if (error.code === 'CONNECTION_NOT_FOUND') return new OnlineRoomApiError('CONFLICT', error.message, 409)
    return new OnlineRoomApiError('UNAVAILABLE', error.message, 503)
  }
  if (error instanceof OnlinePokerBotJoinError) {
    if (error.code === 'PRIVATE_ROOM_BOT_FORBIDDEN') return new OnlineRoomApiError('FORBIDDEN', 'Bots cannot join private online rooms.', 403)
    return new OnlineRoomApiError('CONFLICT', 'This poker bot is disabled.', 409)
  }
  if (error instanceof PokerTableError) {
    if (error.code === 'STALE_STATE_VERSION') return new OnlineRoomApiError('STALE_STATE', 'The table changed. Refresh and retry the action.', 409)
    if (error.code === 'NO_ACTIVE_HAND') return new OnlineRoomApiError('HAND_NOT_ACTIVE', 'There is no active hand.', 409)
    if (error.code === 'PLAYER_NOT_SEATED') return new OnlineRoomApiError('NOT_FOUND', 'The authenticated user is not seated at this table.', 404)
    if (error.code === 'TABLE_FULL' || error.code === 'SEAT_OCCUPIED' || error.code === 'HAND_IN_PROGRESS') return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
    return new OnlineRoomApiError('INVALID_ACTION', error.message, 400)
  }
  if (error instanceof OnlineRoomError) {
    if (error.code === 'STALE_ROOM_VERSION') return new OnlineRoomApiError('CONFLICT', 'The room changed. Refresh and retry the action.', 409)
    if (error.code === 'ROOM_CLOSED') return new OnlineRoomApiError('CLOSED', 'This online room is closed.', 410)
    if (error.code === 'PLAYER_NOT_IN_ROOM') return new OnlineRoomApiError('NOT_FOUND', 'The authenticated user is not in this online room.', 404)
    if (error.code === 'PLAYER_ALREADY_IN_ROOM' || error.code === 'TABLE_FULL' || error.code === 'HAND_IN_PROGRESS') {
      return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
    }
    return new OnlineRoomApiError('INVALID_ACTION', error.message, 400)
  }
  if (isDatabaseUnavailableError(error)) {
    return new OnlineRoomApiError('UNAVAILABLE', 'Online room service is temporarily unavailable.', 503)
  }
  const code = (error as { code?: string } | null)?.code
  if (code === 'PRIVATE_ROOM_AUTH_REQUIRED') return new OnlineRoomApiError('FORBIDDEN', 'A valid private room credential is required.', 403)
  if (code === 'ROOM_CLOSED') return new OnlineRoomApiError('CLOSED', 'This online room is closed.', 410)
  if (code === 'PLAYER_NOT_IN_ROOM') return new OnlineRoomApiError('NOT_FOUND', 'The authenticated user is not seated in this room.', 404)
  if (code === 'STALE_ROOM_VERSION' || code === 'INVALID_ROOM_VERSION' || code === 'PLAYER_ALREADY_IN_ROOM' || code === 'TABLE_FULL' || code === 'SEAT_OCCUPIED' || code === 'HAND_IN_PROGRESS' || code === 'ALREADY_SEATED' || code === 'BUY_IN_UNAVAILABLE') {
    return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
  }
  if (error instanceof Error) {
    const errorText = `${error.message} ${(error as { statusMessage?: string }).statusMessage ?? ''}`
    if (/недостаточно|insufficient/i.test(errorText)) return new OnlineRoomApiError('CONFLICT', 'Недостаточно фишек для входа за стол.', 409)
    if (/not this player['’]s turn/i.test(error.message)) return new OnlineRoomApiError('NOT_YOUR_TURN', error.message, 409)
    if (/round is complete|cannot act|cannot check|cannot call|no longer in the hand|unknown betting action|amount must be|bet is only|raise is only|raise is not reopened|must be at least|must increase|amount exceeds/i.test(error.message)) {
      return new OnlineRoomApiError('INVALID_ACTION', error.message, 400)
    }
  }
  throw error
}

function firstAvailableOnlineSeat(room: OnlineRoomState, requestedSeat: number | undefined): number {
  if (requestedSeat !== undefined) return requestedSeat
  const occupied = new Set(room.pokerTable.players.map(player => player.seat))
  for (let seat = 1; seat <= 6; seat += 1) if (!occupied.has(seat)) return seat
  fail('CONFLICT', 'The online room is full.', 409)
}

function normalizeMetadata(row: {
  id: string
  roomCode: string
  visibility: string
  ownerId: string
  status: string
  maxPlayers: number
  privateJoinSecretHash: string | null
  startingStack: bigint
  createdAt: Date
}): PersistentRoom {
  if (row.visibility !== 'PUBLIC' && row.visibility !== 'PRIVATE') fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  if (row.status !== 'WAITING' && row.status !== 'CLOSED') fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  if (row.maxPlayers !== 6) fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  const startingStack = Number(row.startingStack)
  if (!Number.isSafeInteger(startingStack) || startingStack < 1) fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  return Object.freeze({
    id: row.id,
    roomCode: normalizeGlobalRoomCode(row.roomCode),
    visibility: row.visibility,
    ownerId: row.ownerId,
    status: row.status,
    maxPlayers: 6,
    privateJoinSecretHash: row.privateJoinSecretHash,
    startingStack,
    createdAt: row.createdAt
  })
}

async function loadPersistentRoom(code: string): Promise<PersistentRoom> {
  let normalizedCode: string
  try {
    normalizedCode = normalizeGlobalRoomCode(code)
  } catch {
    fail('BAD_REQUEST', 'A valid room code is required.', 400)
  }
  const resolution = await resolveRoomCode(normalizedCode)
  if (!resolution || resolution.roomType !== 'ONLINE') fail('NOT_FOUND', 'Online room was not found.', 404)
  const row = await prisma.onlineRoom.findUnique({
    where: { id: resolution.targetId },
    select: { id: true, roomCode: true, visibility: true, ownerId: true, status: true, maxPlayers: true, privateJoinSecretHash: true, startingStack: true, createdAt: true }
  })
  if (!row) fail('NOT_FOUND', 'Online room was not found.', 404)
  return normalizeMetadata(row)
}

async function requireRuntime(room: PersistentRoom, dependencies?: OnlineRoomApiDependencies): Promise<OnlineRoomRuntimeRecord> {
  try {
    const record = await runtimeStore(dependencies).get(room.id)
    if (!record) fail('UNAVAILABLE', 'Online room runtime is unavailable.', 503)
    if (record.state.roomCode !== room.roomCode || record.state.type !== 'ONLINE') {
      fail('UNAVAILABLE', 'Online room runtime does not match persistent metadata.', 503)
    }
    if (record.state.status === 'CLOSED') {
      await markClosed(room.id).catch(() => undefined)
      fail('CLOSED', 'This online room is closed.', 410)
    }
    return record
  } catch (error) {
    throw mapRuntimeError(error)
  }
}

async function markClosed(roomId: string): Promise<void> {
  await prisma.onlineRoom.update({ where: { id: roomId }, data: { status: 'CLOSED' } })
}

async function recoverPendingOnlineCashOuts(roomId: string, dependencies?: OnlineRoomApiDependencies): Promise<void> {
  const pending = await pendingOnlineCashOuts(roomId)
  if (pending.length === 0) return
  let runtime: OnlineRoomRuntimeRecord | null
  try {
    runtime = await runtimeStore(dependencies).get(roomId)
  } catch {
    // Redis outage must not turn an unresolved reservation into a cash-out.
    return
  }
  const seated = new Set(runtime?.state.pokerTable.players.map(player => player.playerId) ?? [])
  for (const userId of pending) if (!seated.has(userId)) await completeOnlineCashOut({ roomId, userId })
}

async function recoverPendingOnlineBuyIns(roomId: string, dependencies?: OnlineRoomApiDependencies): Promise<void> {
  const pending = await pendingOnlineBuyIns(roomId)
  if (pending.length === 0) return
  for (const reservation of pending) {
    await reconcileOnlineBuyIn({ roomId, userId: reservation.userId, sequence: reservation.sequence }, async () => {
      const runtime = await runtimeStore(dependencies).get(roomId)
      return runtime?.state.pokerTable.players.find(player => player.playerId === reservation.userId)?.seat ?? null
    })
  }
}

async function syncMetadataAfterMutation(room: PersistentRoom, next: OnlineRoomState): Promise<void> {
  if (next.status === 'CLOSED') {
    await markClosed(room.id)
    return
  }
  if (next.ownerId && next.ownerId !== room.ownerId) {
    await prisma.onlineRoom.update({ where: { id: room.id }, data: { ownerId: next.ownerId } })
  }
}

function ensureOpen(room: PersistentRoom): void {
  if (room.status === 'CLOSED') fail('CLOSED', 'This online room is closed.', 410)
}

export async function resolveOnlineRoomCode(code: string): Promise<Readonly<{ type: 'HOME' | 'ONLINE' | 'NOT_FOUND'; code: string; targetId?: string }>> {
  let normalizedCode: string
  try {
    normalizedCode = normalizeGlobalRoomCode(code)
  } catch {
    fail('BAD_REQUEST', 'A valid room code is required.', 400)
  }
  const resolution = await resolveRoomCode(normalizedCode)
  return resolution
    ? Object.freeze({ type: resolution.roomType, code: resolution.normalizedCode, targetId: resolution.targetId })
    : Object.freeze({ type: 'NOT_FOUND' as const, code: normalizedCode })
}

/** Lists only public lobby metadata; private rooms and runtime internals stay server-side. */
export async function listPublicOnlineRooms(): Promise<readonly OnlineRoomLobbyEntry[]> {
  const rows = await prisma.onlineRoom.findMany({
    where: { visibility: 'PUBLIC', status: 'WAITING' },
    select: { id: true, roomCode: true, createdAt: true, startingStack: true },
    orderBy: { createdAt: 'desc' },
    take: 100
  })
  const runtime = new OnlineRoomRuntimeStore()
  try {
    const entries: OnlineRoomLobbyEntry[] = []
    for (const row of rows) {
      const record = await runtime.get(row.id)
      if (!record || record.state.status === 'CLOSED' || record.state.visibility !== 'PUBLIC') continue
      entries.push(Object.freeze({
        code: record.state.roomCode,
        playerCount: record.state.pokerTable.players.length,
        maxPlayers: 6,
        status: record.state.pokerTable.status === 'IN_HAND' ? 'IN_HAND' : 'WAITING',
        createdAt: row.createdAt.toISOString(),
        startingStack: Number(row.startingStack),
        smallBlind: record.state.pokerTable.smallBlind,
        bigBlind: record.state.pokerTable.bigBlind
      }))
    }
    return Object.freeze(entries)
  } finally {
    await runtime.disconnect().catch(() => undefined)
  }
}

/** Internal orchestration count; it returns no bot-owner markers to public clients. */
export async function countPublicOnlineRoomsOwnedByBots(botIds: readonly string[]): Promise<number> {
  if (botIds.length === 0) return 0
  return prisma.onlineRoom.count({ where: { visibility: 'PUBLIC', status: 'WAITING', ownerId: { in: [...botIds] } } })
}

/**
 * Closes stale empty bot-created public rooms. DB row locking prevents a buy-in
 * reservation from racing with closure; runtime state is removed only after
 * the authoritative snapshot confirms there are no seats or active hands.
 */
export async function closeEmptyPublicOnlineRoomsCreatedByBots(
  botIds: readonly string[],
  olderThan: Date,
  dependencies?: OnlineRoomApiDependencies
): Promise<number> {
  if (botIds.length === 0) return 0
  const candidates = await prisma.onlineRoom.findMany({
    where: { ownerId: { in: [...botIds] }, visibility: 'PUBLIC', status: { in: ['WAITING', 'CLOSED'] }, createdAt: { lt: olderThan } },
    select: { id: true, roomCode: true }
  })
  let closedCount = 0
  for (const candidate of candidates) {
    let current: OnlineRoomRuntimeRecord | null
    try { current = await runtimeStore(dependencies).get(candidate.id) } catch { continue }
    if (current && (current.state.visibility !== 'PUBLIC' || current.state.pokerTable.players.length > 0 ||
        (current.state.pokerTable.currentHand !== null && current.state.pokerTable.currentHand.street !== 'FINISHED'))) continue
    const closed = await prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "online_rooms" WHERE id=${candidate.id}::uuid FOR UPDATE`
      if (!locked.length || !['WAITING', 'CLOSED'].includes(locked[0]!.status)) return false
      const activeSeats = await tx.onlineRoomPlayer.count({ where: { roomId: candidate.id, status: { in: ['RESERVING', 'ACTIVE', 'CASH_OUT_PENDING'] } } })
      if (activeSeats > 0) return false
      if (locked[0]!.status === 'CLOSED') return true
      const result = await tx.onlineRoom.updateMany({ where: { id: candidate.id, visibility: 'PUBLIC', status: 'WAITING' }, data: { status: 'CLOSED' } })
      return result.count === 1
    })
    if (!closed) continue
    if (current) {
      try { await runtimeStore(dependencies).remove(candidate.id, current.runtimeRevision) }
      catch (error) {
        if (!(error instanceof OnlineRoomRuntimeStoreError) || error.code !== 'ROOM_NOT_FOUND') continue
      }
    }
    closedCount += 1
  }
  return closedCount
}

/** Finds a bot's durable active public seat after process restart. */
export async function findActivePublicOnlineRoomForPlayer(userId: string): Promise<string | null> {
  const row = await prisma.onlineRoomPlayer.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'RESERVING', 'CASH_OUT_PENDING'] }, room: { visibility: 'PUBLIC', status: { not: 'CLOSED' } } },
    orderBy: { updatedAt: 'desc' },
    select: { room: { select: { roomCode: true } } }
  })
  return row?.room.roomCode ?? null
}

/** Projects only bot-owned cards and legal public data for the server strategy engine. */
export async function getOnlinePokerBotDecisionSnapshot(userId: string, code: string, dependencies?: OnlineRoomApiDependencies): Promise<OnlinePokerBotDecisionSnapshot> {
  requireUserId(userId)
  try { await assertOnlinePokerBotMayJoin(userId, 'PUBLIC') } catch (error) { throw mapRuntimeError(error) }
  const metadata = await loadPersistentRoom(code)
  if (metadata.visibility !== 'PUBLIC') fail('FORBIDDEN', 'Bots cannot access private online rooms.', 403)
  const record = await requireRuntime(metadata, dependencies)
  const hand = record.state.pokerTable.currentHand
  if (!hand) fail('HAND_NOT_ACTIVE', 'There is no active hand.', 409)
  const player = hand.players.find(candidate => candidate.playerId === userId)
  if (!player) fail('NOT_FOUND', 'The bot is not seated in this room.', 404)
  const result = await safeOnlineRoomResult(record.state, userId, record.runtimeRevision)
  const playerLevel = hand.lastActedAtBet.find(level => level.playerId === userId)
  return Object.freeze({
    room: result.room,
    legalActions: getLegalBettingActions(hand, userId),
    toCall: getToCall(hand, userId),
    minRaiseTo: getMinimumRaiseTo(hand),
    raiseReopened: !playerLevel || hand.currentBet - playerLevel.bet >= hand.lastFullRaiseSize
  })
}

export async function createAuthenticatedOnlineRoom(userId: string, input: CreateAuthenticatedOnlineRoomInput = {}, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const visibility = input.visibility ?? 'PUBLIC'
  if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE') fail('BAD_REQUEST', 'Room visibility must be PUBLIC or PRIVATE.', 400)
  try {
    await assertOnlinePokerBotMayJoin(userId, visibility)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  const startingStack = requireInteger(input.startingStack ?? DEFAULT_OWNER_STACK, 'Starting stack', 1, 1_000_000_000)
  const smallBlind = requireInteger(input.smallBlind ?? DEFAULT_SMALL_BLIND, 'Small blind', 1, 1_000_000_000)
  const bigBlind = requireInteger(input.bigBlind ?? DEFAULT_BIG_BLIND, 'Big blind', smallBlind, 1_000_000_000)
  const ownerSeat = requireInteger(input.ownerSeat ?? 1, 'Owner seat', 1, 6)
  let privateJoinSecretHash: string | undefined
  if (visibility === 'PRIVATE') {
    if (typeof input.privateJoinSecret !== 'string' || input.privateJoinSecret.length < 1 || input.privateJoinSecret.length > 128) {
      fail('BAD_REQUEST', 'A private room credential is required.', 400)
    }
    privateJoinSecretHash = hashSecret(input.privateJoinSecret)
  } else if (input.privateJoinSecret !== undefined) {
    fail('BAD_REQUEST', 'Public rooms cannot include a private credential.', 400)
  }

  let metadata: PersistentRoom
  try {
    // Reserve the code in a closed state first. The metadata becomes joinable only
    // after the authoritative Redis runtime has been created successfully.
    const created = await createPersistentOnlineRoom({ ownerId: userId, visibility, status: 'CLOSED', maxPlayers: 6, privateJoinSecretHash, startingStack })
    metadata = Object.freeze({
      ...created,
      privateJoinSecretHash: privateJoinSecretHash ?? null,
      createdAt: new Date(created.createdAt)
    })
  } catch (error) {
    throw mapRuntimeError(error)
  }

  const state = createOnlineRoom({
    roomId: metadata.id,
    roomCode: metadata.roomCode,
    ownerId: userId,
    ownerStack: startingStack,
    ownerSeat,
    smallBlind,
    bigBlind,
    visibility,
    createdAt: metadata.createdAt,
    ...(privateJoinSecretHash ? { privateJoinSecret: privateJoinSecretHash } : {})
  })
  let ownerReservation: OnlineBuyInReservation | null = null
  let ownerActivated = false
  try {
    ownerReservation = await reserveInitialOnlineRoomBuyIn({ roomId: metadata.id, userId, seat: ownerSeat, amount: startingStack })
    await runtimeStore(dependencies).connect()
    const record = await commitOnlineBuyInSeat({ roomId: metadata.id, userId, sequence: ownerReservation.sequence, seat: ownerSeat, allowClosed: true }, async tx => {
      const created = await runtimeStore(dependencies).create(state, dependencies?.botFence)
      await tx.onlineRoom.update({ where: { id: metadata.id }, data: { status: 'WAITING' } })
      return created
    })
    ownerActivated = true
    const result = await safeOnlineRoomResult(record.state, userId, record.runtimeRevision)
    void publishOnlineRoomChanged({
      type: 'ROOM_CHANGED',
      roomId: record.state.roomId,
      roomCode: record.state.roomCode,
      roomVersion: record.state.roomVersion,
      tableStateVersion: record.state.pokerTable.stateVersion
    }).catch(() => undefined)
    return result
  } catch (error) {
    if (!ownerActivated) {
      // A transaction commit can succeed even if its acknowledgement is lost.
      // Never tear down a runtime unless PostgreSQL confirms this reservation
      // is still pending; on an ambiguous DB result leave both stores intact.
      let stillReserving = false
      if (ownerReservation) {
        try {
          stillReserving = (await pendingOnlineBuyIns(metadata.id)).some(row => row.userId === userId && row.sequence === ownerReservation!.sequence)
        } catch {
          stillReserving = false
        }
      }
      if (stillReserving) {
        // Recovery decides from a fresh authoritative runtime read: an owner
        // seat is activated and publishes the room; no seat is refunded.
        await recoverPendingOnlineBuyIns(metadata.id, dependencies).catch(() => undefined)
      } else if (!ownerReservation) {
        await markClosed(metadata.id).catch(() => undefined)
      }
    }
    throw mapRuntimeError(error)
  }
}

export async function getAuthenticatedOnlineRoom(userId: string, code: string, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  let metadata = await loadPersistentRoom(code)
  try {
    await recoverPendingOnlineBuyIns(metadata.id, dependencies)
    await recoverPendingOnlineCashOuts(metadata.id, dependencies)
    // Recovery can publish a creator room that was still in its CLOSED
    // staging state when the process stopped after Redis wrote the funded seat.
    metadata = await loadPersistentRoom(code)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  ensureOpen(metadata)
  let record: OnlineRoomRuntimeRecord
  try {
    record = await requireRuntime(metadata, dependencies)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  if (record.state.pokerTable.finalizedHand) await recordFinalizedOnlinePokerHand(record.state)
  if (metadata.visibility === 'PRIVATE' && !record.state.pokerTable.players.some(player => player.playerId === userId)) {
    fail('FORBIDDEN', 'Join the private room before viewing its state.', 403)
  }
  const result = await safeOnlineRoomResult(record.state, userId, record.runtimeRevision)
  if (result.room.pokerTable.currentHand?.turnDeadlineAt !== null && result.room.pokerTable.currentHand?.turnDeadlineAt !== undefined) {
    try {
      const timer = timerStore(dependencies)
      timer.start(jobToProcessor(dependencies))
      const job = timerJobFromSafeResult(result, record.runtimeRevision)
      if (job) await timer.schedule(job)
    } catch {
      // Redis remains authoritative; a request cannot execute a local timeout fallback.
    }
  }
  return result
}

/**
 * Reconciles transport presence with the authoritative seated-player metadata.
 * The CAS update changes only the connected flag; a running hand is preserved.
 */
export async function setAuthenticatedOnlineRoomPresence(
  userId: string,
  code: string,
  connected: boolean,
  dependencies?: OnlineRoomApiDependencies
): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  if (typeof connected !== 'boolean') fail('BAD_REQUEST', 'Connected must be boolean.', 400)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getAuthenticatedOnlineRoom(userId, code, dependencies)
    const player = current.room.pokerTable.players.find(candidate => candidate.playerId === userId)
    if (!player) fail('NOT_FOUND', 'The authenticated user is not seated in this room.', 404)
    if (player.connected === connected) return current
    try {
      return await updateRoom(userId, code, { concurrencyToken: current.concurrencyToken }, state => setOnlineRoomConnected(state, userId, connected), dependencies)
    } catch (error) {
      const mapped = mapRuntimeError(error)
      if (mapped.code === 'CONFLICT' && attempt < 2) continue
      throw mapped
    }
  }
  fail('CONFLICT', 'The room changed. Refresh and retry the presence update.', 409)
}

type RuntimeActionInput = Readonly<{
  playerId: string
  actionId: string
  fingerprint: string
}>

type InternalRoomUpdateResult = Readonly<{
  result: ApiOnlineRoomResult
  duplicate: boolean
  runtimeRevision: number
}>

async function finishRoomRuntimeMutation(
  userId: string,
  metadata: PersistentRoom,
  record: OnlineRoomRuntimeRecord,
  duplicate: boolean,
  dependencies?: OnlineRoomApiDependencies
): Promise<InternalRoomUpdateResult> {
  // Keep every global Prisma operation outside callers' interactive
  // transactions. In particular, a funded join holds a wallet/room lock while
  // its Redis seat CAS runs; profile/rating/metadata reads must not check out a
  // second connection from a PgBouncer pool of size one.
  if (record.state.pokerTable.finalizedHand) await recordFinalizedOnlinePokerHand(record.state)
  if (!duplicate) {
    await syncMetadataAfterMutation(metadata, record.state).catch(() => undefined)
    void publishOnlineRoomChanged({
      type: 'ROOM_CHANGED',
      roomId: record.state.roomId,
      roomCode: record.state.roomCode,
      roomVersion: record.state.roomVersion,
      tableStateVersion: record.state.pokerTable.stateVersion
    }).catch(() => undefined)
  }
  return Object.freeze({
    result: await safeOnlineRoomResult(record.state, userId, record.runtimeRevision),
    duplicate,
    runtimeRevision: record.runtimeRevision
  })
}

async function updateRoomInternal(
  userId: string,
  code: string,
  input: OnlineRoomConcurrencyInput,
  updater: (state: OnlineRoomState) => OnlineRoomState,
  dependencies?: OnlineRoomApiDependencies,
  action?: RuntimeActionInput
): Promise<InternalRoomUpdateResult> {
  requireUserId(userId)
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  let current: OnlineRoomRuntimeRecord
  try {
    current = await requireRuntime(metadata, dependencies)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  const revision = expectedRevision(metadata.id, input?.concurrencyToken)
  if (revision !== current.runtimeRevision) fail('CONFLICT', 'The room changed. Refresh and retry the action.', 409)
  try {
    const updated = action
      ? await runtimeStore(dependencies).updateWithAction(metadata.id, revision, action.playerId, action.actionId, action.fingerprint, state => updater(state), dependencies?.botFence)
      : Object.freeze({ record: await runtimeStore(dependencies).update(metadata.id, revision, state => updater(state), dependencies?.botFence), duplicate: false })
    // Rating writes are idempotent by (user, hand). Retrying a finalized action
    // must also retry the durable result projection if the prior DB write failed.
    return await finishRoomRuntimeMutation(userId, metadata, updated.record, updated.duplicate, dependencies)
  } catch (error) {
    throw mapRuntimeError(error)
  }
}

async function updateRoom(
  userId: string,
  code: string,
  input: OnlineRoomConcurrencyInput,
  updater: (state: OnlineRoomState) => OnlineRoomState,
  dependencies?: OnlineRoomApiDependencies
): Promise<ApiOnlineRoomResult> {
  return (await updateRoomInternal(userId, code, input, updater, dependencies)).result
}

export async function joinAuthenticatedOnlineRoom(userId: string, code: string, input: JoinAuthenticatedOnlineRoomInput, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  try {
    await assertOnlinePokerBotMayJoin(userId, metadata.visibility)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  const seat = input.seat === undefined ? undefined : requireInteger(input.seat, 'Seat', 1, 6)
  if (metadata.visibility === 'PRIVATE') {
    if (!metadata.privateJoinSecretHash || typeof input.joinSecret !== 'string' || !verifySecret(input.joinSecret, metadata.privateJoinSecretHash)) {
      fail('FORBIDDEN', 'A valid private room credential is required.', 403)
    }
  }
  const currentRecord = await requireRuntime(metadata, dependencies)
  const currentPlayer = currentRecord.state.pokerTable.players.find(player => player.playerId === userId)
  if (currentPlayer) {
    // A retry/reconnect never buys in again. Keep the historical conflict
    // semantics for a second seat attempt while returning no new mutation.
    fail('CONFLICT', 'The authenticated user is already seated in this room.', 409)
  }
  if (currentRecord.state.pokerTable.currentHand && currentRecord.state.pokerTable.currentHand.street !== 'FINISHED') {
    fail('CONFLICT', 'Нельзя занять место во время раздачи. Попробуйте после её завершения.', 409)
  }
  const targetSeat = firstAvailableOnlineSeat(currentRecord.state, seat)
  let reservation: OnlineBuyInReservation
  try {
    reservation = await reserveOnlineBuyIn({ roomId: metadata.id, userId, seat: targetSeat, amount: metadata.startingStack })
  } catch (error) {
    throw mapRuntimeError(error)
  }
  const currentInput: OnlineRoomConcurrencyInput = input.concurrencyToken
    ? { concurrencyToken: input.concurrencyToken, expectedRoomVersion: input.expectedRoomVersion }
    : { ...input, concurrencyToken: issueConcurrencyToken(metadata.id, currentRecord.runtimeRevision) }
  try {
    const record = await commitOnlineBuyInSeat({ roomId: metadata.id, userId, sequence: reservation.sequence, seat: reservation.seat }, () => {
      // The reservation transaction owns the wallet/room locks until Redis
      // confirms the seat and PostgreSQL can mark it ACTIVE. Do only the
      // authoritative Redis CAS here: updateRoomInternal performs room-code,
      // profile, rating and metadata queries through the global Prisma client,
      // which deadlocks when PgBouncer provides just this transaction's one
      // connection.
      const revision = expectedRevision(metadata.id, currentInput.concurrencyToken)
      return runtimeStore(dependencies).update(metadata.id, revision, state => {
        const joinSecret = metadata.privateJoinSecretHash ?? undefined
        if (metadata.visibility === 'PRIVATE' && state.privateJoinSecret !== joinSecret) fail('UNAVAILABLE', 'Private room authorization state is inconsistent.', 503)
        return joinOnlineRoom(state, { playerId: userId, stack: reservation.amount, seat: reservation.seat, ...(joinSecret ? { joinSecret } : {}), expectedRoomVersion: input.expectedRoomVersion })
      }, dependencies?.botFence)
    })
    return (await finishRoomRuntimeMutation(userId, metadata, record, false, dependencies)).result
  } catch (error) {
    // Reconcile only after the reservation transaction has released its row
    // lock. This rereads Redis while holding the same DB lock, so a failed CAS
    // refunds once and a successful-but-unconfirmed CAS is activated.
    await recoverPendingOnlineBuyIns(metadata.id, dependencies).catch(() => undefined)
    throw mapRuntimeError(error)
  }
}

export async function leaveAuthenticatedOnlineRoom(userId: string, code: string, input: OnlineRoomConcurrencyInput, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  const current = await requireRuntime(metadata, dependencies)
  const player = current.state.pokerTable.players.find(candidate => candidate.playerId === userId)
  if (!player) fail('NOT_FOUND', 'The authenticated user is not seated in this room.', 404)
  const runningHand = current.state.pokerTable.currentHand !== null && current.state.pokerTable.currentHand.street !== 'FINISHED'
  if (runningHand) {
    return updateRoom(userId, code, input, state => leaveOnlineRoom(state, userId, { expectedRoomVersion: input.expectedRoomVersion }), dependencies)
  }

  let prepared: boolean
  try {
    prepared = await prepareOnlineCashOut({ roomId: metadata.id, userId, amount: player.stack })
  } catch (error) {
    throw mapRuntimeError(error)
  }
  let runtimeLeft = false
  try {
    const result = await updateRoom(userId, code, input, state => leaveOnlineRoom(state, userId, { expectedRoomVersion: input.expectedRoomVersion }), dependencies)
    runtimeLeft = true
    await completeOnlineCashOut({ roomId: metadata.id, userId })
    return result
  } catch (error) {
    if (prepared && !runtimeLeft) {
      try {
        const latest = await runtimeStore(dependencies).get(metadata.id)
        if (latest?.state.pokerTable.players.some(candidate => candidate.playerId === userId)) {
          await clearOnlineCashOut({ roomId: metadata.id, userId }).catch(() => undefined)
        }
      } catch {
        // Keep the pending reservation through a Redis outage.
      }
    }
    throw mapRuntimeError(error)
  }
}

export async function setAuthenticatedOnlineRoomReady(userId: string, code: string, input: ReadyAuthenticatedOnlineRoomInput, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  if (typeof input.ready !== 'boolean') fail('BAD_REQUEST', 'Ready must be boolean.', 400)
  return updateRoom(userId, code, input, state => setOnlineRoomReady(state, userId, input.ready, { expectedRoomVersion: input.expectedRoomVersion }), dependencies)
}

export async function setAuthenticatedOnlineRoomSittingOut(userId: string, code: string, input: SittingOutAuthenticatedOnlineRoomInput, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  if (typeof input.sittingOut !== 'boolean') fail('BAD_REQUEST', 'Sitting-out must be boolean.', 400)
  return updateRoom(userId, code, input, state => setOnlineRoomSittingOut(state, userId, input.sittingOut, { expectedRoomVersion: input.expectedRoomVersion }), dependencies)
}

function actionFingerprint(input: AuthenticatedOnlineRoomActionInput): string {
  return JSON.stringify({
    expectedTableStateVersion: input.expectedTableStateVersion,
    action: { type: input.action.type, ...(input.action.amount === undefined ? {} : { amount: input.action.amount }) }
  })
}

function validateSocketActionInput(input: AuthenticatedOnlineRoomActionInput): void {
  if (!input || typeof input.actionId !== 'string' || input.actionId.length < 8 || input.actionId.length > 128) {
    fail('BAD_REQUEST', 'Action id must be a bounded non-empty string.', 400)
  }
  if (!Number.isSafeInteger(input.expectedTableStateVersion) || input.expectedTableStateVersion < 0) {
    fail('BAD_REQUEST', 'Expected table state version must be a non-negative integer.', 400)
  }
  if (!input.action || typeof input.action.type !== 'string') fail('BAD_REQUEST', 'A poker action is required.', 400)
  const amount = input.action.amount
  if (['bet', 'raise'].includes(input.action.type) && (!Number.isSafeInteger(amount) || (amount as number) <= 0)) {
    fail('BAD_REQUEST', 'Bet and raise actions require a positive integer amount.', 400)
  }
  if (!['bet', 'raise'].includes(input.action.type) && input.action.amount !== undefined) {
    fail('BAD_REQUEST', 'This poker action must not include an amount.', 400)
  }
}

/** Applies a player action using the authenticated session as the actor. */
export async function applyAuthenticatedOnlineRoomAction(
  userId: string,
  code: string,
  input: AuthenticatedOnlineRoomActionInput,
  dependencies?: OnlineRoomApiDependencies
): Promise<AuthenticatedOnlineRoomActionResult> {
  requireUserId(userId)
  validateSocketActionInput(input)
  const current = await getAuthenticatedOnlineRoom(userId, code, dependencies)
  const updated = await updateRoomInternal(
    userId,
    code,
    { concurrencyToken: current.concurrencyToken },
    state => withNextTurnDeadline(advanceCompletedStreet(applyOnlineRoomAction(state, {
      action: { ...input.action, playerId: userId },
      expectedStateVersion: input.expectedTableStateVersion
    }))),
    dependencies,
    { playerId: userId, actionId: input.actionId, fingerprint: actionFingerprint(input) }
  )
  if (!updated.duplicate) await reconcileTurnTimer(updated.result, dependencies, updated.runtimeRevision)
  return Object.freeze({ ...updated.result, duplicate: updated.duplicate })
}

/** Starts a hand using the existing table/hand engine; cards and blinds stay server controlled. */
export async function startAuthenticatedOnlineRoomHand(
  userId: string,
  code: string,
  expectedTableStateVersion: number,
  dependencies?: OnlineRoomApiDependencies
): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  if (!Number.isSafeInteger(expectedTableStateVersion) || expectedTableStateVersion < 0) {
    fail('BAD_REQUEST', 'Expected table state version must be a non-negative integer.', 400)
  }
  const current = await getAuthenticatedOnlineRoom(userId, code, dependencies)
  if (current.room.ownerId !== userId) fail('FORBIDDEN', 'Only the room owner can start a hand.', 403)
  const metadata = await loadPersistentRoom(code)
  const currentRecord = await requireRuntime(metadata, dependencies)
  const settledBeforeStart = advanceCompletedStreet(currentRecord.state, expectedTableStateVersion)
  const pendingCashOuts = canStartNextHand(settledBeforeStart.pokerTable)
    ? settledBeforeStart.pendingLeaves.map(playerId => ({
        userId: playerId,
        amount: settledBeforeStart.pokerTable.players.find(player => player.playerId === playerId)?.stack ?? 0
      }))
    : []
  try {
    for (const pending of pendingCashOuts) await prepareOnlineCashOut({ roomId: metadata.id, userId: pending.userId, amount: pending.amount })
  } catch (error) {
    throw mapRuntimeError(error)
  }
  let runtimeStarted = false
  const updated = await updateRoomInternal(userId, code, { concurrencyToken: current.concurrencyToken }, state => {
    if (state.ownerId !== userId) fail('FORBIDDEN', 'Only the room owner can start a hand.', 403)
    const settled = advanceCompletedStreet(state, expectedTableStateVersion)
    if (!canStartNextHand(settled.pokerTable)) fail('INVALID_ACTION', 'At least two eligible players are required to start a hand.', 409)
    const started = startOnlineRoomHand(settled, { expectedStateVersion: settled.pokerTable.stateVersion })
    runtimeStarted = true
    return withNextTurnDeadline(advanceCompletedStreet(started))
  }, dependencies).catch(async error => {
    if (!runtimeStarted) {
      try {
        const latest = await runtimeStore(dependencies).get(metadata.id)
        for (const pending of pendingCashOuts) {
          if (latest?.state.pokerTable.players.some(player => player.playerId === pending.userId)) {
            await clearOnlineCashOut({ roomId: metadata.id, userId: pending.userId }).catch(() => undefined)
          }
        }
      } catch {
        // Keep the pending cash-out when Redis is unavailable; recovery will
        // reconcile it after the authoritative runtime is reachable.
      }
    }
    throw error
  })
  for (const pending of pendingCashOuts) await completeOnlineCashOut({ roomId: metadata.id, userId: pending.userId })
  await reconcileTurnTimer(updated.result, dependencies, updated.runtimeRevision)
  return updated.result
}

/** Executes one claimed timeout through the same authoritative poker action path. */
export async function processAuthenticatedOnlineRoomTimeout(
  job: OnlineRoomTurnTimerJob,
  dependencies?: OnlineRoomApiDependencies
): Promise<'COMPLETED' | 'STALE' | 'RETRY'> {
  let current: OnlineRoomRuntimeRecord | null
  try {
    current = await runtimeStore(dependencies).get(job.roomId)
  } catch {
    return 'RETRY'
  }
  if (!current) return 'STALE'
  if (job.deadlineAt > Date.now() || (job.runtimeRevision !== undefined && current.runtimeRevision !== job.runtimeRevision)) return 'STALE'
  const state = current.state
  const hand = state.pokerTable.currentHand
  if (!hand || state.turnDeadlineAt !== job.deadlineAt || state.pokerTable.stateVersion !== job.expectedTableStateVersion ||
      hand.handId !== job.handId || hand.street !== job.street || hand.currentActor === null || hand.bettingRoundComplete) {
    return 'STALE'
  }
  const actor = hand.players.find(player => player.seat === hand.currentActor)
  if (!actor || actor.playerId !== job.playerId || actor.status !== 'ACTIVE' || actor.stack <= 0) return 'STALE'

  const timeoutType = getToCall(hand, actor.playerId) === 0 ? 'check' as const : 'fold' as const
  try {
    const updated = await runtimeStore(dependencies).update(state.roomId, current.runtimeRevision, latest => {
      const latestHand = latest.pokerTable.currentHand
      if (!latestHand || latest.turnDeadlineAt !== job.deadlineAt || latest.pokerTable.stateVersion !== job.expectedTableStateVersion ||
          (job.runtimeRevision !== undefined && current.runtimeRevision !== job.runtimeRevision) ||
          latestHand.handId !== job.handId || latestHand.street !== job.street || latestHand.currentActor === null || latestHand.bettingRoundComplete) {
        throw new OnlineRoomApiError('STALE_STATE', 'The turn timer is stale.', 409)
      }
      const latestActor = latestHand.players.find(player => player.seat === latestHand.currentActor)
      if (!latestActor || latestActor.playerId !== job.playerId || latestActor.status !== 'ACTIVE' || latestActor.stack <= 0) {
        throw new OnlineRoomApiError('STALE_STATE', 'The turn timer is stale.', 409)
      }
      return withNextTurnDeadline(advanceCompletedStreet(applyOnlineRoomAction(latest, {
        action: { playerId: job.playerId, type: timeoutType },
        expectedStateVersion: job.expectedTableStateVersion
      })))
    })
    const safe = await safeOnlineRoomResult(updated.state, undefined, updated.runtimeRevision)
    void publishOnlineRoomChanged({
      type: 'ROOM_CHANGED',
      roomId: updated.state.roomId,
      roomCode: updated.state.roomCode,
      roomVersion: updated.state.roomVersion,
      tableStateVersion: updated.state.pokerTable.stateVersion
    }).catch(() => undefined)
    await reconcileTurnTimer(safe, dependencies, updated.runtimeRevision)
    return 'COMPLETED'
  } catch (error) {
    if (error instanceof OnlineRoomApiError && error.code === 'STALE_STATE') return 'STALE'
    if (error instanceof OnlineRoomRuntimeStoreError && error.code === 'STALE_STATE') return 'STALE'
    return 'RETRY'
  }
}
