import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { prisma } from '../db/client'
import {
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  setOnlineRoomReady,
  setOnlineRoomSittingOut,
  toPlayerSafeOnlineRoomState,
  type OnlineRoomState
} from '../utils/pokerOnlineRoom'
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
    if (error.code === 'ROOM_NOT_FOUND') return new OnlineRoomApiError('UNAVAILABLE', 'Online room runtime is unavailable.', 503)
    return new OnlineRoomApiError('UNAVAILABLE', 'Online room runtime is temporarily unavailable.', 503)
  }
  const code = (error as { code?: string } | null)?.code
  if (code === 'PRIVATE_ROOM_AUTH_REQUIRED') return new OnlineRoomApiError('FORBIDDEN', 'A valid private room credential is required.', 403)
  if (code === 'ROOM_CLOSED') return new OnlineRoomApiError('CLOSED', 'This online room is closed.', 410)
  if (code === 'PLAYER_NOT_IN_ROOM') return new OnlineRoomApiError('NOT_FOUND', 'The authenticated user is not seated in this room.', 404)
  if (code === 'STALE_ROOM_VERSION' || code === 'INVALID_ROOM_VERSION' || code === 'PLAYER_ALREADY_IN_ROOM' || code === 'TABLE_FULL' || code === 'SEAT_OCCUPIED' || code === 'HAND_IN_PROGRESS') {
    return new OnlineRoomApiError('CONFLICT', 'The requested room operation conflicts with its current state.', 409)
  }
  if (error instanceof OnlineRoomApiError) return error
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
    return Object.freeze({
      room: toPlayerSafeOnlineRoomState(record.state, userId),
      concurrencyToken: issueConcurrencyToken(record.state.roomId, record.runtimeRevision)
    })
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
  const record = await requireRuntime(metadata, dependencies)
  if (metadata.visibility === 'PRIVATE' && !record.state.pokerTable.players.some(player => player.playerId === userId)) {
    fail('FORBIDDEN', 'Join the private room before viewing its state.', 403)
  }
  return Object.freeze({ room: toPlayerSafeOnlineRoomState(record.state, userId), concurrencyToken: issueConcurrencyToken(record.state.roomId, record.runtimeRevision) })
}

async function updateRoom(
  userId: string,
  code: string,
  input: OnlineRoomConcurrencyInput,
  updater: (state: OnlineRoomState) => OnlineRoomState,
  dependencies?: OnlineRoomApiDependencies
): Promise<ApiOnlineRoomResult> {
  requireUserId(userId)
  const metadata = await loadPersistentRoom(code)
  ensureOpen(metadata)
  const current = await requireRuntime(metadata, dependencies)
  const revision = expectedRevision(metadata.id, input?.concurrencyToken)
  if (revision !== current.runtimeRevision) fail('CONFLICT', 'The room changed. Refresh and retry the action.', 409)
  try {
    const next = await runtimeStore(dependencies).update(metadata.id, revision, state => updater(state))
    await syncMetadataAfterMutation(metadata, next.state).catch(() => undefined)
    return Object.freeze({ room: toPlayerSafeOnlineRoomState(next.state, userId), concurrencyToken: issueConcurrencyToken(next.state.roomId, next.runtimeRevision) })
  } catch (error) {
    throw mapRuntimeError(error)
  }
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
