import { applyBettingAction, type BettingAction } from './pokerBetting'
import { type Card, type Deck } from './pokerDeck'
import { finishHand } from './pokerHandFinalizer'
import { prepareNextHand, type NextHandPlayer } from './pokerNextHand'
import {
  advanceStreet,
  type HandPlayerState,
  type InternalHandState,
  type PlayerSafeHandPlayer
} from './pokerHandState'

export const MAX_TABLE_PLAYERS = 6 as const
export const TABLE_STATUSES = ['WAITING', 'IN_HAND'] as const
export type PokerTableStatus = typeof TABLE_STATUSES[number]

export type PokerTablePlayer = Readonly<{
  playerId: string
  seat: number
  stack: number
  connected: boolean
  ready: boolean
  sittingOut: boolean
}>

export type PokerTableSeat = Readonly<{
  seat: number
  playerId: string | null
}>

export type PokerTableState = Readonly<{
  tableId: string
  maxPlayers: typeof MAX_TABLE_PLAYERS
  seats: readonly PokerTableSeat[]
  players: readonly PokerTablePlayer[]
  currentHand: InternalHandState | null
  dealerSeat: number | null
  status: PokerTableStatus
  stateVersion: number
  handSequence: number
  /** Identifies the terminal hand whose payout has already been applied. */
  finalizedHandId: string | null
  smallBlind: number
  bigBlind: number
}>

export type CreatePokerTableOptions = Readonly<{
  tableId: string
  smallBlind: number
  bigBlind: number
}>

export type SeatPlayerOptions = Readonly<{
  playerId: string
  seat: number
  stack: number
  connected?: boolean
  ready?: boolean
  sittingOut?: boolean
}>

export type TableAction = BettingAction & Readonly<{
  expectedStateVersion?: number
}>

export type StartTableHandOptions = Readonly<{
  deck?: Deck
  expectedStateVersion?: number
}>

export type PokerTableErrorCode =
  | 'INVALID_TABLE'
  | 'INVALID_PLAYER'
  | 'TABLE_FULL'
  | 'SEAT_OCCUPIED'
  | 'PLAYER_ALREADY_SEATED'
  | 'PLAYER_NOT_SEATED'
  | 'HAND_IN_PROGRESS'
  | 'NO_ACTIVE_HAND'
  | 'STALE_STATE_VERSION'

export class PokerTableError extends Error {
  readonly code: PokerTableErrorCode

  constructor(code: PokerTableErrorCode, message: string) {
    super(message)
    this.name = 'PokerTableError'
    this.code = code
  }
}

function fail(code: PokerTableErrorCode, message: string): never {
  throw new PokerTableError(code, message)
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
}

function assertBoolean(value: boolean | undefined, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be boolean.`)
}

function assertTable(table: PokerTableState): void {
  if (!table || table.maxPlayers !== MAX_TABLE_PLAYERS || !Array.isArray(table.players)) {
    fail('INVALID_TABLE', 'A valid poker table state is required.')
  }
}

function assertExpectedVersion(table: PokerTableState, expectedStateVersion: number | undefined): void {
  if (expectedStateVersion === undefined) return
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion !== table.stateVersion) {
    fail('STALE_STATE_VERSION', `Expected table state version ${String(expectedStateVersion)} does not match ${table.stateVersion}.`)
  }
}

function hasRunningHand(table: PokerTableState): boolean {
  return table.currentHand !== null && table.currentHand.street !== 'FINISHED'
}

function sortedPlayers(players: readonly PokerTablePlayer[]): readonly PokerTablePlayer[] {
  return Object.freeze([...players].sort((left, right) => left.seat - right.seat))
}

function makeSeats(players: readonly PokerTablePlayer[]): readonly PokerTableSeat[] {
  const bySeat = new Map(players.map(player => [player.seat, player.playerId]))
  return Object.freeze(Array.from({ length: MAX_TABLE_PLAYERS }, (_, index) => Object.freeze({
    seat: index + 1,
    playerId: bySeat.get(index + 1) ?? null
  })))
}

function freezePlayer(player: PokerTablePlayer): PokerTablePlayer {
  return Object.freeze({ ...player })
}

function makeTable(
  base: Omit<PokerTableState, 'players' | 'seats'> & { players: readonly PokerTablePlayer[] }
): PokerTableState {
  const players = sortedPlayers(base.players.map(freezePlayer))
  return Object.freeze({
    ...base,
    players,
    seats: makeSeats(players)
  })
}

function withVersion(table: PokerTableState, patch: Partial<Omit<PokerTableState, 'players' | 'seats'>> & { players?: readonly PokerTablePlayer[] }): PokerTableState {
  return makeTable({
    ...table,
    ...patch,
    stateVersion: table.stateVersion + 1,
    players: patch.players ?? table.players
  })
}

function tablePlayer(table: PokerTableState, playerId: string): PokerTablePlayer {
  const player = table.players.find(candidate => candidate.playerId === playerId)
  if (!player) fail('PLAYER_NOT_SEATED', `Player ${playerId} is not seated at this table.`)
  return player
}

function handPlayerMap(hand: InternalHandState): ReadonlyMap<string, HandPlayerState> {
  return new Map(hand.players.map(player => [player.playerId, player]))
}

function syncPlayersFromHand(table: PokerTableState, hand: InternalHandState): readonly PokerTablePlayer[] {
  const handPlayers = handPlayerMap(hand)
  return table.players.map(player => {
    const handPlayer = handPlayers.get(player.playerId)
    return handPlayer ? freezePlayer({ ...player, stack: handPlayer.stack }) : player
  })
}

function eligiblePlayers(table: PokerTableState): NextHandPlayer[] {
  return table.players
    .filter(player => player.connected && player.ready && !player.sittingOut && player.stack > 0)
    .map(player => ({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      active: player.connected,
      sittingOut: player.sittingOut
    }))
}

/** Creates an empty immutable six-seat table. */
export function createPokerTable(options: CreatePokerTableOptions): PokerTableState {
  if (!options || typeof options.tableId !== 'string' || options.tableId.trim().length === 0) {
    throw new Error('Table id must be a non-empty string.')
  }
  assertPositiveInteger(options.smallBlind, 'Small blind')
  assertPositiveInteger(options.bigBlind, 'Big blind')
  if (options.bigBlind < options.smallBlind) throw new Error('Big blind must be greater than or equal to small blind.')
  return makeTable({
    tableId: options.tableId,
    maxPlayers: MAX_TABLE_PLAYERS,
    players: [],
    currentHand: null,
    dealerSeat: null,
    status: 'WAITING',
    stateVersion: 0,
    handSequence: 0,
    finalizedHandId: null,
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind
  })
}

/** Seats one player; join/seat mutations are allowed only between hands. */
export function seatPlayer(table: PokerTableState, options: SeatPlayerOptions): PokerTableState {
  assertTable(table)
  if (hasRunningHand(table)) fail('HAND_IN_PROGRESS', 'Players cannot take seats during an active hand.')
  if (table.players.length >= MAX_TABLE_PLAYERS) fail('TABLE_FULL', 'The poker table is full.')
  if (typeof options.playerId !== 'string' || options.playerId.trim().length === 0) fail('INVALID_PLAYER', 'Player id must be a non-empty string.')
  assertPositiveInteger(options.seat, 'Seat')
  if (options.seat > MAX_TABLE_PLAYERS) fail('INVALID_PLAYER', `Seat must be between 1 and ${MAX_TABLE_PLAYERS}.`)
  assertNonNegativeInteger(options.stack, `Stack for ${options.playerId}`)
  assertBoolean(options.connected, 'Connected')
  assertBoolean(options.ready, 'Ready')
  assertBoolean(options.sittingOut, 'Sitting-out')
  if (table.players.some(player => player.playerId === options.playerId)) fail('PLAYER_ALREADY_SEATED', `Player ${options.playerId} is already seated.`)
  if (table.players.some(player => player.seat === options.seat)) fail('SEAT_OCCUPIED', `Seat ${options.seat} is occupied.`)

  const player = freezePlayer({
    playerId: options.playerId,
    seat: options.seat,
    stack: options.stack,
    connected: options.connected ?? true,
    ready: options.ready ?? false,
    sittingOut: options.sittingOut ?? false
  })
  return withVersion(table, { players: [...table.players, player] })
}

/** Leaves a table between hands and releases the player's seat. */
export function leavePlayer(table: PokerTableState, playerId: string): PokerTableState {
  assertTable(table)
  if (hasRunningHand(table)) fail('HAND_IN_PROGRESS', 'Players cannot leave during an active hand.')
  tablePlayer(table, playerId)
  return withVersion(table, {
    players: table.players.filter(player => player.playerId !== playerId),
    currentHand: null,
    status: 'WAITING'
  })
}

function updatePlayer(
  table: PokerTableState,
  playerId: string,
  update: (player: PokerTablePlayer) => PokerTablePlayer,
  allowDuringHand: boolean
): PokerTableState {
  assertTable(table)
  if (!allowDuringHand && hasRunningHand(table)) fail('HAND_IN_PROGRESS', 'This table setting cannot change during an active hand.')
  const current = tablePlayer(table, playerId)
  const changed = update(current)
  if (changed === current) return table
  return withVersion(table, { players: table.players.map(player => player.playerId === playerId ? changed : player) })
}

export function setPlayerReady(table: PokerTableState, playerId: string, ready: boolean): PokerTableState {
  assertBoolean(ready, 'Ready')
  return updatePlayer(table, playerId, player => player.ready === ready ? player : freezePlayer({ ...player, ready }), false)
}

export function setPlayerSittingOut(table: PokerTableState, playerId: string, sittingOut: boolean): PokerTableState {
  assertBoolean(sittingOut, 'Sitting-out')
  return updatePlayer(table, playerId, player => player.sittingOut === sittingOut ? player : freezePlayer({ ...player, sittingOut }), false)
}

/** Transport disconnect changes table metadata but never mutates a running hand. */
export function setPlayerConnected(table: PokerTableState, playerId: string, connected: boolean): PokerTableState {
  assertBoolean(connected, 'Connected')
  return updatePlayer(table, playerId, player => player.connected === connected ? player : freezePlayer({ ...player, connected }), true)
}

export function canStartNextHand(table: PokerTableState): boolean {
  assertTable(table)
  return !hasRunningHand(table) && eligiblePlayers(table).length >= 2
}

/** Starts a hand through prepareNextHand and increments table sequence/version. */
export function startTableHand(table: PokerTableState, options: StartTableHandOptions = {}): PokerTableState {
  assertTable(table)
  assertExpectedVersion(table, options.expectedStateVersion)
  if (hasRunningHand(table)) fail('HAND_IN_PROGRESS', 'The table already has an active hand.')

  const prepared = prepareNextHand({
    players: eligiblePlayers(table),
    previousDealerSeat: table.dealerSeat ?? undefined,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    deck: options.deck
  })
  if (prepared.status === 'WAITING') {
    return table.currentHand === null
      ? table
      : withVersion(table, { currentHand: null, status: 'WAITING' })
  }

  const players = syncPlayersFromHand(table, prepared.hand)
  return withVersion(table, {
    players,
    currentHand: prepared.hand,
    dealerSeat: prepared.hand.dealerSeat,
    status: 'IN_HAND',
    handSequence: table.handSequence + 1,
    finalizedHandId: null
  })
}

/** Applies exactly one existing betting-engine action under table version control. */
export function applyTableAction(table: PokerTableState, action: TableAction, expectedStateVersion?: number): PokerTableState {
  assertTable(table)
  assertExpectedVersion(table, expectedStateVersion ?? action.expectedStateVersion)
  if (!table.currentHand || table.currentHand.street === 'FINISHED') fail('NO_ACTIVE_HAND', 'The table has no active hand.')
  const hand = applyBettingAction(table.currentHand, {
    playerId: action.playerId,
    type: action.type,
    ...(action.amount === undefined ? {} : { amount: action.amount })
  })
  return withVersion(table, {
    players: syncPlayersFromHand(table, hand),
    currentHand: hand,
    status: 'IN_HAND'
  })
}

export type PublicTableHandPlayer = Readonly<Pick<HandPlayerState, 'playerId' | 'seat' | 'stack' | 'contribution' | 'streetContribution' | 'status'> & {
  holeCards: readonly Card[]
}>

export type PublicTableHandState = Readonly<{
  handId: string
  dealerSeat: number
  smallBlindSeat: number
  bigBlindSeat: number
  smallBlind: number
  bigBlind: number
  board: readonly Card[]
  street: InternalHandState['street']
  pot: number
  currentBet: number
  bettingRoundComplete: boolean
  currentActor: number | null
  turnDeadlineAt: number | null
  players: readonly PublicTableHandPlayer[]
}>

export type PlayerSafeTableState = Readonly<Omit<PokerTableState, 'currentHand' | 'seats' | 'players'> & {
  seats: readonly PokerTableSeat[]
  players: readonly PokerTablePlayer[]
  currentHand: PublicTableHandState | null
}>

function safeHand(hand: InternalHandState, viewerPlayerId: string | undefined, turnDeadlineAt: number | null): PublicTableHandState {
  const players = Object.freeze(hand.players.map(player => Object.freeze({
    playerId: player.playerId,
    seat: player.seat,
    stack: player.stack,
    contribution: player.contribution,
    streetContribution: player.streetContribution,
    status: player.status,
    holeCards: Object.freeze(player.playerId === viewerPlayerId ? [...player.holeCards] : [])
  })))
  return Object.freeze({
    handId: hand.handId,
    dealerSeat: hand.dealerSeat,
    smallBlindSeat: hand.smallBlindSeat,
    bigBlindSeat: hand.bigBlindSeat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: Object.freeze([...hand.board]),
    street: hand.street,
    pot: hand.pot,
    currentBet: hand.currentBet,
    bettingRoundComplete: hand.bettingRoundComplete,
    currentActor: hand.currentActor,
    turnDeadlineAt,
    players
  })
}

/** Builds a public table snapshot; unknown/spectator viewers receive no hole cards. */
export function toPlayerSafeTableState(table: PokerTableState, viewerPlayerId?: string, turnDeadlineAt: number | null = null): PlayerSafeTableState {
  assertTable(table)
  return Object.freeze({
    tableId: table.tableId,
    maxPlayers: table.maxPlayers,
    status: table.status,
    dealerSeat: table.dealerSeat,
    stateVersion: table.stateVersion,
    handSequence: table.handSequence,
    finalizedHandId: table.finalizedHandId,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    seats: Object.freeze(table.seats.map(seat => Object.freeze({ ...seat }))),
    players: Object.freeze(table.players.map(player => Object.freeze({ ...player }))),
    currentHand: table.currentHand ? safeHand(table.currentHand, viewerPlayerId, turnDeadlineAt) : null
  })
}

/** Advances a completed hand street through the existing server-side street engine. */
export function advanceTableStreet(table: PokerTableState, expectedStateVersion?: number): PokerTableState {
  assertTable(table)
  assertExpectedVersion(table, expectedStateVersion)
  if (!table.currentHand || table.currentHand.street === 'FINISHED') fail('NO_ACTIVE_HAND', 'The table has no active hand.')
  const hand = advanceStreet(table.currentHand)
  return withVersion(table, {
    players: syncPlayersFromHand(table, hand),
    currentHand: hand,
    status: hand.street === 'FINISHED' ? 'WAITING' : 'IN_HAND'
  })
}

/** Applies a completed hand's payout to table stacks exactly once. */
export function finalizeTableHand(table: PokerTableState, expectedStateVersion?: number): PokerTableState {
  assertTable(table)
  assertExpectedVersion(table, expectedStateVersion)
  const hand = table.currentHand
  if (!hand || (hand.street !== 'SHOWDOWN' && hand.street !== 'FINISHED')) {
    fail('NO_ACTIVE_HAND', 'The table does not have a terminal hand to finalize.')
  }
  if (table.finalizedHandId === hand.handId) return table

  const result = finishHand(hand)
  const resultByPlayer = new Map(result.players.map(player => [player.playerId, player.stack]))
  const finalizedHand = Object.freeze({
    ...hand,
    street: 'FINISHED' as const,
    currentActor: null,
    bettingRoundComplete: true
  })
  return withVersion(table, {
    players: table.players.map(player => {
      const stack = resultByPlayer.get(player.playerId)
      return stack === undefined ? player : freezePlayer({ ...player, stack })
    }),
    currentHand: finalizedHand,
    status: 'WAITING',
    finalizedHandId: hand.handId
  })
}
