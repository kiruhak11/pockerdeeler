import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { prisma } from '../db/client'
import {
  applyOnlineRoomAction,
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  setOnlineRoomReady,
  setOnlineRoomSittingOut,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState,
  type ApplyOnlineRoomActionOptions,
  OnlineRoomError,
  type OnlineRoomState
} from '../utils/pokerOnlineRoom'
import { PokerTableError, canStartNextHand } from '../utils/pokerTableState'
import { hashSecret, verifySecret } from './authService'
import {
  createPersistentOnlineRoom,
  normalizeGlobalRoomCode,
  resolveRoomCode
} from './roomCodeRegistryService'
import {
  OnlineRoomRuntimeStore,
  OnlineRoomRuntimeStoreError,
  type OnlineRoomRuntimeRecord
} from './onlineRoomRuntimeStore'
import { publishOnlineRoomChanged } from './onlineRoomRealtimeService'

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

export type JoinAuthenticatedOnlineRoomInput = OnlineRoomConcurrencyInput & Readonly<{
  stack?: number
  seat?: number
  joinSecret?: string
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

type PersistentRoom = Readonly<{
  id: string
  roomCode: string
  visibility: 'PUBLIC' | 'PRIVATE'
  ownerId: string
  status: 'WAITING' | 'CLOSED'
  maxPlayers: 6
  privateJoinSecretHash: string | null
  createdAt: Date
}>

let defaultRuntime: OnlineRoomRuntimeStore | undefined

function runtimeStore(dependencies?: OnlineRoomApiDependencies): OnlineRoomRuntimeStore {
  if (dependencies?.runtime) return dependencies.runtime
  return (defaultRuntime ??= new OnlineRoomRuntimeStore())
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
  return createHash('sha256').update(process.env.ROOM_SECRET_PEPPER || 'dev-pepper').digest()
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
    if (error.code === 'PLAYER_ALREADY_IN_ROOM' || error.code === 'TABLE_FULL') {
      return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
    }
    return new OnlineRoomApiError('INVALID_ACTION', error.message, 400)
  }
  const code = (error as { code?: string } | null)?.code
  if (code === 'PRIVATE_ROOM_AUTH_REQUIRED') return new OnlineRoomApiError('FORBIDDEN', 'A valid private room credential is required.', 403)
  if (code === 'ROOM_CLOSED') return new OnlineRoomApiError('CLOSED', 'This online room is closed.', 410)
  if (code === 'PLAYER_NOT_IN_ROOM') return new OnlineRoomApiError('NOT_FOUND', 'The authenticated user is not seated in this room.', 404)
  if (code === 'STALE_ROOM_VERSION' || code === 'INVALID_ROOM_VERSION' || code === 'PLAYER_ALREADY_IN_ROOM' || code === 'TABLE_FULL' || code === 'SEAT_OCCUPIED' || code === 'HAND_IN_PROGRESS') {
    return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
  }
  if (error instanceof Error) {
    if (/not this player['’]s turn/i.test(error.message)) return new OnlineRoomApiError('NOT_YOUR_TURN', error.message, 409)
    if (/round is complete|cannot act|cannot check|cannot call|no longer in the hand|unknown betting action|amount must be|bet is only|raise is only|raise is not reopened|must be at least|must increase|amount exceeds/i.test(error.message)) {
      return new OnlineRoomApiError('INVALID_ACTION', error.message, 400)
    }
  }
  return new OnlineRoomApiError('UNAVAILABLE', 'Online room service is temporarily unavailable.', 503)
}

function normalizeMetadata(row: {
  id: string
  roomCode: string
  visibility: string
  ownerId: string
  status: string
  maxPlayers: number
  privateJoinSecretHash: string | null
  createdAt: Date
}): PersistentRoom {
  if (row.visibility !== 'PUBLIC' && row.visibility !== 'PRIVATE') fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  if (row.status !== 'WAITING' && row.status !== 'CLOSED') fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  if (row.maxPlayers !== 6) fail('UNAVAILABLE', 'Stored online room metadata is invalid.', 503)
  return Object.freeze({
    id: row.id,
    roomCode: normalizeGlobalRoomCode(row.roomCode),
    visibility: row.visibility,
    ownerId: row.ownerId,
    status: row.status,
    maxPlayers: 6,
    privateJoinSecretHash: row.privateJoinSecretHash,
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
    select: { id: true, roomCode: true, visibility: true, ownerId: true, status: true, maxPlayers: true, privateJoinSecretHash: true, createdAt: true }
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

export async function createAuthenticatedOnlineRoom(userId: string, input: CreateAuthenticatedOnlineRoomInput = {}, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const visibility = input.visibility ?? 'PUBLIC'
  if (visibility !== 'PUBLIC' && visibility !== 'PRIVATE') fail('BAD_REQUEST', 'Room visibility must be PUBLIC or PRIVATE.', 400)
  const startingStack = requireInteger(input.startingStack ?? DEFAULT_OWNER_STACK, 'Starting stack', 0, 1_000_000_000)
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
    const created = await createPersistentOnlineRoom({ ownerId: userId, visibility, status: 'CLOSED', maxPlayers: 6, privateJoinSecretHash })
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
  try {
    const record = await runtimeStore(dependencies).create(state)
    try {
      await prisma.onlineRoom.update({ where: { id: metadata.id }, data: { status: 'WAITING' } })
    } catch (error) {
      await runtimeStore(dependencies).remove(metadata.id, record.runtimeRevision).catch(() => undefined)
      throw error
    }
    const result = Object.freeze({
      room: toPlayerSafeOnlineRoomState(record.state, userId),
      concurrencyToken: issueConcurrencyToken(record.state.roomId, record.runtimeRevision)
    })
    void publishOnlineRoomChanged({
      type: 'ROOM_CHANGED',
      roomId: record.state.roomId,
      roomCode: record.state.roomCode,
      roomVersion: record.state.roomVersion,
      tableStateVersion: record.state.pokerTable.stateVersion
    }).catch(() => undefined)
    return result
  } catch (error) {
    // The registry claim is deliberately retained, while the metadata is made closed.
    // This prevents an active persistent room without runtime state and prevents code reuse.
    await markClosed(metadata.id).catch(() => undefined)
    throw mapRuntimeError(error)
  }
}

export async function getAuthenticatedOnlineRoom(userId: string, code: string, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  let record: OnlineRoomRuntimeRecord
  try {
    record = await requireRuntime(metadata, dependencies)
  } catch (error) {
    throw mapRuntimeError(error)
  }
  if (metadata.visibility === 'PRIVATE' && !record.state.pokerTable.players.some(player => player.playerId === userId)) {
    fail('FORBIDDEN', 'Join the private room before viewing its state.', 403)
  }
  return Object.freeze({ room: toPlayerSafeOnlineRoomState(record.state, userId), concurrencyToken: issueConcurrencyToken(record.state.roomId, record.runtimeRevision) })
}

type RuntimeActionInput = Readonly<{
  playerId: string
  actionId: string
  fingerprint: string
}>

type InternalRoomUpdateResult = Readonly<{
  result: ApiOnlineRoomResult
  duplicate: boolean
}>

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
      ? await runtimeStore(dependencies).updateWithAction(metadata.id, revision, action.playerId, action.actionId, action.fingerprint, state => updater(state))
      : Object.freeze({ record: await runtimeStore(dependencies).update(metadata.id, revision, state => updater(state)), duplicate: false })
    if (!updated.duplicate) {
      await syncMetadataAfterMutation(metadata, updated.record.state).catch(() => undefined)
      void publishOnlineRoomChanged({
        type: 'ROOM_CHANGED',
        roomId: updated.record.state.roomId,
        roomCode: updated.record.state.roomCode,
        roomVersion: updated.record.state.roomVersion,
        tableStateVersion: updated.record.state.pokerTable.stateVersion
      }).catch(() => undefined)
    }
    return Object.freeze({
      result: Object.freeze({ room: toPlayerSafeOnlineRoomState(updated.record.state, userId), concurrencyToken: issueConcurrencyToken(updated.record.state.roomId, updated.record.runtimeRevision) }),
      duplicate: updated.duplicate
    })
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
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  const stack = requireInteger(input.stack ?? DEFAULT_OWNER_STACK, 'Stack', 0, 1_000_000_000)
  const seat = input.seat === undefined ? undefined : requireInteger(input.seat, 'Seat', 1, 6)
  if (metadata.visibility === 'PRIVATE') {
    if (!metadata.privateJoinSecretHash || typeof input.joinSecret !== 'string' || !verifySecret(input.joinSecret, metadata.privateJoinSecretHash)) {
      fail('FORBIDDEN', 'A valid private room credential is required.', 403)
    }
  }
  return updateRoom(userId, code, input, state => {
    const joinSecret = metadata.privateJoinSecretHash ?? undefined
    if (metadata.visibility === 'PRIVATE' && state.privateJoinSecret !== joinSecret) fail('UNAVAILABLE', 'Private room authorization state is inconsistent.', 503)
    return joinOnlineRoom(state, { playerId: userId, stack, ...(seat === undefined ? {} : { seat }), ...(joinSecret ? { joinSecret } : {}), expectedRoomVersion: input.expectedRoomVersion })
  }, dependencies)
}

export async function leaveAuthenticatedOnlineRoom(userId: string, code: string, input: OnlineRoomConcurrencyInput, dependencies?: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult> {
  return updateRoom(userId, code, input, state => leaveOnlineRoom(state, userId, { expectedRoomVersion: input.expectedRoomVersion }), dependencies)
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
    state => applyOnlineRoomAction(state, {
      action: { ...input.action, playerId: userId },
      expectedStateVersion: input.expectedTableStateVersion
    }),
    dependencies,
    { playerId: userId, actionId: input.actionId, fingerprint: actionFingerprint(input) }
  )
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
  return updateRoom(userId, code, { concurrencyToken: current.concurrencyToken }, state => {
    if (state.ownerId !== userId) fail('FORBIDDEN', 'Only the room owner can start a hand.', 403)
    if (!canStartNextHand(state.pokerTable)) fail('INVALID_ACTION', 'At least two eligible players are required to start a hand.', 409)
    return startOnlineRoomHand(state, { expectedStateVersion: expectedTableStateVersion })
  }, dependencies)
}
