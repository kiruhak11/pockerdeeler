import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import {
  applyTableAction,
  createPokerTable,
  leavePlayer,
  seatPlayer,
  setPlayerConnected,
  setPlayerReady,
  setPlayerSittingOut,
  startTableHand,
  toPlayerSafeTableState,
  type PlayerSafeTableState,
  type PokerTableState,
  type SeatPlayerOptions,
  type StartTableHandOptions,
  type TableAction
} from './pokerTableState'

export const ONLINE_ROOM_TYPE = 'ONLINE' as const
export const ONLINE_ROOM_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const
export type OnlineRoomVisibility = typeof ONLINE_ROOM_VISIBILITIES[number]

export const ONLINE_ROOM_STATUSES = ['WAITING', 'IN_HAND', 'CLOSED'] as const
export type OnlineRoomStatus = typeof ONLINE_ROOM_STATUSES[number]

export const ONLINE_ROOM_MAX_PLAYERS = 6 as const
export const ONLINE_ROOM_CODE_LENGTH = 6 as const

// This is deliberately a plain, unprefixed code format so a future resolver
// can query one normalized namespace shared by HOME and ONLINE rooms.
const ONLINE_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ONLINE_ROOM_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/

export type OnlineRoomState = Readonly<{
  roomId: string
  roomCode: string
  type: typeof ONLINE_ROOM_TYPE
  visibility: OnlineRoomVisibility
  ownerId: string | null
  status: OnlineRoomStatus
  createdAt: string
  maxPlayers: typeof ONLINE_ROOM_MAX_PLAYERS
  pokerTable: PokerTableState
  roomVersion: number
  /** Server-authoritative deadline for the current actor, or null when no timer is active. */
  turnDeadlineAt: number | null
  /** Players who requested leave during a hand; released after the hand. */
  pendingLeaves: readonly string[]
  /** Internal server-only authorization material for private rooms. */
  privateJoinSecret?: string
}>

export type CreateOnlineRoomOptions = Readonly<{
  ownerId: string
  ownerStack: number
  smallBlind: number
  bigBlind: number
  visibility?: OnlineRoomVisibility
  ownerSeat?: number
  roomId?: string
  roomCode?: string
  createdAt?: Date | string
  /** Server-only injection for deterministic tests or a trusted caller. */
  privateJoinSecret?: string
}>

export type JoinOnlineRoomOptions = Readonly<{
  playerId: string
  stack: number
  seat?: number
  joinSecret?: string
  expectedRoomVersion?: number
}>

export type RoomVersionOptions = Readonly<{
  expectedRoomVersion?: number
}>

export type StartOnlineRoomHandOptions = Readonly<StartTableHandOptions & RoomVersionOptions>

export type ApplyOnlineRoomActionOptions = Readonly<{
  action: TableAction
  expectedRoomVersion?: number
  expectedStateVersion?: number
}>

export type OnlineRoomErrorCode =
  | 'INVALID_ROOM'
  | 'INVALID_ROOM_CODE'
  | 'ROOM_CLOSED'
  | 'PRIVATE_ROOM_AUTH_REQUIRED'
  | 'TABLE_FULL'
  | 'HAND_IN_PROGRESS'
  | 'PLAYER_ALREADY_IN_ROOM'
  | 'PLAYER_NOT_IN_ROOM'
  | 'INVALID_ROOM_VERSION'
  | 'STALE_ROOM_VERSION'

export class OnlineRoomError extends Error {
  readonly code: OnlineRoomErrorCode

  constructor(code: OnlineRoomErrorCode, message: string) {
    super(message)
    this.name = 'OnlineRoomError'
    this.code = code
  }
}

function fail(code: OnlineRoomErrorCode, message: string): never {
  throw new OnlineRoomError(code, message)
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
}

function assertVisibility(value: OnlineRoomVisibility): void {
  if (!ONLINE_ROOM_VISIBILITIES.includes(value)) {
    throw new Error(`Room visibility must be PUBLIC or PRIVATE.`)
  }
}

function assertRoom(room: OnlineRoomState): void {
  if (!room || room.type !== ONLINE_ROOM_TYPE || room.maxPlayers !== ONLINE_ROOM_MAX_PLAYERS || !room.pokerTable) {
    fail('INVALID_ROOM', 'A valid online room state is required.')
  }
}

function assertExpectedRoomVersion(room: OnlineRoomState, expectedRoomVersion: number | undefined): void {
  if (expectedRoomVersion === undefined) return
  if (!Number.isSafeInteger(expectedRoomVersion)) {
    fail('INVALID_ROOM_VERSION', 'Expected room version must be a safe integer.')
  }
  if (expectedRoomVersion !== room.roomVersion) {
    fail('STALE_ROOM_VERSION', `Expected room version ${expectedRoomVersion} does not match ${room.roomVersion}.`)
  }
}

function normalizeCreatedAt(value: Date | string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Created-at timestamp must be valid.')
  return date.toISOString()
}

function hasRunningHand(table: PokerTableState): boolean {
  return table.currentHand !== null && table.currentHand.street !== 'FINISHED'
}

function roomStatusForTable(table: PokerTableState): OnlineRoomStatus {
  return hasRunningHand(table) ? 'IN_HAND' : 'WAITING'
}

function tablePlayerIds(table: PokerTableState): Set<string> {
  return new Set(table.players.map(player => player.playerId))
}

function firstFreeSeat(table: PokerTableState): number {
  const occupied = new Set(table.players.map(player => player.seat))
  for (let seat = 1; seat <= ONLINE_ROOM_MAX_PLAYERS; seat += 1) {
    if (!occupied.has(seat)) return seat
  }
  fail('TABLE_FULL', 'The online room is full.')
}

function chooseOwner(table: PokerTableState, excluded: ReadonlySet<string> = new Set()): string | null {
  return [...table.players]
    .filter(player => !excluded.has(player.playerId))
    .sort((left, right) => left.seat - right.seat)[0]?.playerId ?? null
}

function makeRoom(base: Omit<OnlineRoomState, 'pendingLeaves'> & { pendingLeaves?: readonly string[] }): OnlineRoomState {
  return Object.freeze({
    ...base,
    pendingLeaves: Object.freeze([...(base.pendingLeaves ?? [])])
  })
}

function withRoomVersion(
  room: OnlineRoomState,
  patch: Partial<Omit<OnlineRoomState, 'pendingLeaves'>> & { pendingLeaves?: readonly string[] }
): OnlineRoomState {
  return makeRoom({
    ...room,
    ...patch,
    roomVersion: room.roomVersion + 1,
    pendingLeaves: patch.pendingLeaves ?? room.pendingLeaves
  })
}

function assertPrivateJoin(room: OnlineRoomState, joinSecret: string | undefined): void {
  if (room.visibility !== 'PRIVATE') return
  if (typeof joinSecret !== 'string' || joinSecret.length === 0 || joinSecret !== room.privateJoinSecret) {
    fail('PRIVATE_ROOM_AUTH_REQUIRED', 'A valid private room join secret is required.')
  }
}

function assertKnownPlayer(room: OnlineRoomState, playerId: string): void {
  assertNonEmpty(playerId, 'Player id')
  if (!tablePlayerIds(room.pokerTable).has(playerId)) {
    fail('PLAYER_NOT_IN_ROOM', `Player ${playerId} is not in this online room.`)
  }
}

/** Normalizes and validates the six-character online room code format. */
export function normalizeOnlineRoomCode(value: string): string {
  if (typeof value !== 'string') throw new Error('Room code must be a string.')
  const normalized = value.trim().toUpperCase()
  if (!ONLINE_ROOM_CODE_PATTERN.test(normalized)) {
    throw new Error('Online room code must contain exactly six unambiguous letters or digits.')
  }
  return normalized
}

export function isValidOnlineRoomCode(value: string): boolean {
  try {
    normalizeOnlineRoomCode(value)
    return true
  } catch {
    return false
  }
}

/** Uses cryptographic randomness; callers still need a global uniqueness check when persisted. */
export function generateOnlineRoomCode(length = ONLINE_ROOM_CODE_LENGTH): string {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 32) {
    throw new Error('Online room code length must be between 1 and 32.')
  }
  let code = ''
  for (let index = 0; index < length; index += 1) {
    code += ONLINE_ROOM_CODE_ALPHABET[randomInt(ONLINE_ROOM_CODE_ALPHABET.length)]
  }
  return code
}

function createPrivateSecret(): string {
  return randomBytes(24).toString('base64url')
}

/** Creates a memory-owned online room and seats the owner through PokerTableState. */
export function createOnlineRoom(options: CreateOnlineRoomOptions): OnlineRoomState {
  if (!options) throw new Error('Online room options are required.')
  assertNonEmpty(options.ownerId, 'Owner id')
  assertNonNegativeInteger(options.ownerStack, 'Owner stack')
  const visibility = options.visibility ?? 'PUBLIC'
  assertVisibility(visibility)
  const roomCode = normalizeOnlineRoomCode(options.roomCode ?? generateOnlineRoomCode())
  const roomId = options.roomId ?? randomUUID()
  assertNonEmpty(roomId, 'Room id')
  const ownerSeat = options.ownerSeat ?? 1
  assertPositiveInteger(ownerSeat, 'Owner seat')
  if (ownerSeat > ONLINE_ROOM_MAX_PLAYERS) throw new Error(`Owner seat must be between 1 and ${ONLINE_ROOM_MAX_PLAYERS}.`)
  if (options.privateJoinSecret !== undefined) assertNonEmpty(options.privateJoinSecret, 'Private join secret')
  if (visibility === 'PUBLIC' && options.privateJoinSecret !== undefined) {
    throw new Error('Public rooms cannot carry a private join secret.')
  }

  let pokerTable = createPokerTable({
    tableId: roomId,
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind
  })
  pokerTable = seatPlayer(pokerTable, {
    playerId: options.ownerId,
    seat: ownerSeat,
    stack: options.ownerStack,
    ready: false,
    connected: true,
    sittingOut: false
  })

  return makeRoom({
    roomId,
    roomCode,
    type: ONLINE_ROOM_TYPE,
    visibility,
    ownerId: options.ownerId,
    status: 'WAITING',
    createdAt: normalizeCreatedAt(options.createdAt),
    maxPlayers: ONLINE_ROOM_MAX_PLAYERS,
    pokerTable,
    roomVersion: 1,
    turnDeadlineAt: null,
    pendingLeaves: [],
    ...(visibility === 'PRIVATE' ? { privateJoinSecret: options.privateJoinSecret ?? createPrivateSecret() } : {})
  })
}

/** Joins through the existing table seat validator; omitted seats use the first free seat. */
export function joinOnlineRoom(room: OnlineRoomState, options: JoinOnlineRoomOptions): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options?.expectedRoomVersion)
  if (room.status === 'CLOSED') fail('ROOM_CLOSED', 'This online room is closed.')
  if (!options) throw new Error('Join options are required.')
  assertNonEmpty(options.playerId, 'Player id')
  assertNonNegativeInteger(options.stack, `Stack for ${options.playerId}`)
  assertPrivateJoin(room, options.joinSecret)
  if (tablePlayerIds(room.pokerTable).has(options.playerId)) {
    fail('PLAYER_ALREADY_IN_ROOM', `Player ${options.playerId} is already in this online room.`)
  }
  if (hasRunningHand(room.pokerTable)) {
    fail('HAND_IN_PROGRESS', 'A spectator can join as a player only after the current hand is finalized.')
  }

  const seat = options.seat ?? firstFreeSeat(room.pokerTable)
  const tableOptions: SeatPlayerOptions = {
    playerId: options.playerId,
    seat,
    stack: options.stack,
    connected: true,
    ready: false,
    sittingOut: false
  }
  const pokerTable = seatPlayer(room.pokerTable, tableOptions)
  return withRoomVersion(room, { pokerTable, status: roomStatusForTable(pokerTable) })
}

/** Releases a seat immediately between hands, or records a deferred departure during a hand. */
export function leaveOnlineRoom(room: OnlineRoomState, playerId: string, options: RoomVersionOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  assertKnownPlayer(room, playerId)
  if (room.status === 'CLOSED') fail('ROOM_CLOSED', 'This online room is closed.')

  if (hasRunningHand(room.pokerTable)) {
    if (room.pendingLeaves.includes(playerId)) return room
    const pokerTable = setPlayerConnected(room.pokerTable, playerId, false)
    const pendingLeaves = [...room.pendingLeaves, playerId]
    const ownerId = room.ownerId === playerId ? chooseOwner(pokerTable, new Set(pendingLeaves)) : room.ownerId
    return withRoomVersion(room, { pokerTable, pendingLeaves, ownerId, status: 'IN_HAND' })
  }

  const pokerTable = leavePlayer(room.pokerTable, playerId)
  const pendingLeaves = room.pendingLeaves.filter(candidate => candidate !== playerId)
  const ownerId = room.ownerId === playerId ? chooseOwner(pokerTable) : room.ownerId
  const status: OnlineRoomStatus = pokerTable.players.length === 0 ? 'CLOSED' : 'WAITING'
  return withRoomVersion(room, {
    pokerTable,
    pendingLeaves,
    ownerId: pokerTable.players.length === 0 ? null : ownerId,
    status
  })
}

/** Safely releases players who requested leave while the previous hand was active. */
export function releasePendingOnlineRoomPlayers(room: OnlineRoomState, options: RoomVersionOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  if (hasRunningHand(room.pokerTable)) throw new Error('Pending players cannot be released during an active hand.')
  if (room.pendingLeaves.length === 0) return room

  let pokerTable = room.pokerTable
  for (const playerId of room.pendingLeaves) {
    if (tablePlayerIds(pokerTable).has(playerId)) pokerTable = leavePlayer(pokerTable, playerId)
  }
  const ownerId = room.ownerId && tablePlayerIds(pokerTable).has(room.ownerId)
    ? room.ownerId
    : chooseOwner(pokerTable)
  return withRoomVersion(room, {
    pokerTable,
    pendingLeaves: [],
    ownerId,
    status: pokerTable.players.length === 0 ? 'CLOSED' : 'WAITING'
  })
}

export function setOnlineRoomReady(room: OnlineRoomState, playerId: string, ready: boolean, options: RoomVersionOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  assertKnownPlayer(room, playerId)
  const pokerTable = setPlayerReady(room.pokerTable, playerId, ready)
  if (pokerTable === room.pokerTable) return room
  return withRoomVersion(room, { pokerTable, status: roomStatusForTable(pokerTable) })
}

export function setOnlineRoomSittingOut(room: OnlineRoomState, playerId: string, sittingOut: boolean, options: RoomVersionOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  assertKnownPlayer(room, playerId)
  const pokerTable = setPlayerSittingOut(room.pokerTable, playerId, sittingOut)
  if (pokerTable === room.pokerTable) return room
  return withRoomVersion(room, { pokerTable, status: roomStatusForTable(pokerTable) })
}

export function setOnlineRoomConnected(room: OnlineRoomState, playerId: string, connected: boolean, options: RoomVersionOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  assertKnownPlayer(room, playerId)
  const pokerTable = setPlayerConnected(room.pokerTable, playerId, connected)
  if (pokerTable === room.pokerTable) return room
  return withRoomVersion(room, { pokerTable, status: roomStatusForTable(pokerTable) })
}

/** Starts a hand through PokerTableState after safely reconciling deferred departures. */
export function startOnlineRoomHand(room: OnlineRoomState, options: StartOnlineRoomHandOptions = {}): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options.expectedRoomVersion)
  if (room.status === 'CLOSED') fail('ROOM_CLOSED', 'This online room is closed.')

  const reconciled = room.pendingLeaves.length > 0 && !hasRunningHand(room.pokerTable)
    ? releasePendingOnlineRoomPlayers(room)
    : room
  const pokerTable = startTableHand(reconciled.pokerTable, {
    deck: options.deck,
    expectedStateVersion: options.expectedStateVersion
  })
  return makeRoom({
    ...reconciled,
    pokerTable,
    status: roomStatusForTable(pokerTable),
    turnDeadlineAt: null,
    pendingLeaves: reconciled.pendingLeaves
  })
}

/** Sets the server-owned turn deadline without changing table state or gameplay. */
export function setOnlineRoomTurnDeadline(room: OnlineRoomState, deadlineAt: number | null): OnlineRoomState {
  assertRoom(room)
  if (deadlineAt !== null && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) {
    throw new Error('Turn deadline must be null or a positive safe integer.')
  }
  if (room.turnDeadlineAt === deadlineAt) return room
  return withRoomVersion(room, { turnDeadlineAt: deadlineAt })
}

/** Applies one server-authoritative betting action without changing room membership version. */
export function applyOnlineRoomAction(room: OnlineRoomState, options: ApplyOnlineRoomActionOptions): OnlineRoomState {
  assertRoom(room)
  assertExpectedRoomVersion(room, options?.expectedRoomVersion)
  if (room.status === 'CLOSED') fail('ROOM_CLOSED', 'This online room is closed.')
  if (!options) throw new Error('Action options are required.')
  const pokerTable = applyTableAction(room.pokerTable, options.action, options.expectedStateVersion)
  return makeRoom({
    ...room,
    pokerTable,
    status: roomStatusForTable(pokerTable),
    pendingLeaves: room.pendingLeaves
  })
}

export function canListOnlineRoomPublicly(room: OnlineRoomState): boolean {
  assertRoom(room)
  return room.visibility === 'PUBLIC' && room.status !== 'CLOSED'
}

export type PlayerSafeOnlineRoomState = Readonly<{
  roomId: string
  roomCode: string
  type: typeof ONLINE_ROOM_TYPE
  visibility: OnlineRoomVisibility
  ownerId: string | null
  status: OnlineRoomStatus
  createdAt: string
  maxPlayers: typeof ONLINE_ROOM_MAX_PLAYERS
  roomVersion: number
  pokerTable: PlayerSafeTableState
}>

/** Omits private authorization data and delegates hand secrecy to PokerTableState. */
export function toPlayerSafeOnlineRoomState(room: OnlineRoomState, viewerPlayerId?: string): PlayerSafeOnlineRoomState {
  assertRoom(room)
  return Object.freeze({
    roomId: room.roomId,
    roomCode: room.roomCode,
    type: room.type,
    visibility: room.visibility,
    ownerId: room.ownerId,
    status: room.status,
    createdAt: room.createdAt,
    maxPlayers: room.maxPlayers,
    roomVersion: room.roomVersion,
    pokerTable: toPlayerSafeTableState(room.pokerTable, viewerPlayerId, room.turnDeadlineAt)
  })
}
