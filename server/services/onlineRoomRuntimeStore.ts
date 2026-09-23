import Redis from 'ioredis'
import { createHash } from 'node:crypto'
import {
  HAND_PLAYER_STATUSES,
  HAND_ACTION_TYPES,
  HAND_STREETS,
  type HandPlayerState,
  type HandActionSummary,
  type InternalHandState,
  type BetActionLevel
} from '../utils/pokerHandState'
import { MAX_TABLE_PLAYERS, TABLE_STATUSES, type PokerTablePlayer, type PokerTableSeat, type PokerTableState } from '../utils/pokerTableState'
import {
  ONLINE_ROOM_MAX_PLAYERS,
  ONLINE_ROOM_STATUSES,
  ONLINE_ROOM_TYPE,
  ONLINE_ROOM_VISIBILITIES,
  type OnlineRoomState
} from '../utils/pokerOnlineRoom'
import { RANKS, SUITS, restoreDeck, snapshotDeck, type Card, type DeckSnapshot } from '../utils/pokerDeck'
import { HAND_CATEGORIES } from '../utils/pokerHandEvaluator'
import type { FinalizedHandResult } from '../utils/pokerShowdownPresentation'

export const ONLINE_ROOM_RUNTIME_SCHEMA_VERSION = 1 as const
export const ONLINE_ROOM_RUNTIME_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
export const ONLINE_ROOM_RUNTIME_KEY_PREFIX = 'pocker:online-room-runtime:v1:'
export const ONLINE_ROOM_ACTION_DEFAULT_TTL_SECONDS = 24 * 60 * 60

export type OnlineRoomRuntimeRecord = Readonly<{
  state: OnlineRoomState
  runtimeRevision: number
}>

export type OnlineRoomActionMutationResult = Readonly<{
  record: OnlineRoomRuntimeRecord
  duplicate: boolean
}>

/** Server-only worker lease fence. It is never serialized in a room snapshot. */
export type OnlineRoomMutationFence = Readonly<{ key: string; token: string }>

export type OnlineRoomRuntimeStoreOptions = Readonly<{
  redisUrl?: string
  redis?: Redis
  keyPrefix?: string
  ttlSeconds?: number
  actionTtlSeconds?: number
}>

export type RuntimeStoreErrorCode =
  | 'REDIS_UNAVAILABLE'
  | 'ROOM_EXISTS'
  | 'ROOM_NOT_FOUND'
  | 'STALE_STATE'
  | 'CORRUPTED_STATE'
  | 'INVALID_STATE'
  | 'INVALID_ARGUMENT'
  | 'ACTION_CONFLICT'

export class OnlineRoomRuntimeStoreError extends Error {
  readonly code: RuntimeStoreErrorCode

  constructor(code: RuntimeStoreErrorCode, message: string) {
    super(message)
    this.name = 'OnlineRoomRuntimeStoreError'
    this.code = code
  }
}

type JsonRecord = Record<string, unknown>
type SerializedRuntimeEnvelope = Readonly<{
  schemaVersion: typeof ONLINE_ROOM_RUNTIME_SCHEMA_VERSION
  runtimeRevision: number
  state: JsonRecord
}>

type SerializedActionRecord = Readonly<{
  fingerprint: string
  runtimeRevision: number
}>

function fail(code: RuntimeStoreErrorCode, message: string): never {
  throw new OnlineRoomRuntimeStoreError(code, message)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) fail('CORRUPTED_STATE', `${label} must be an object.`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('CORRUPTED_STATE', `${label} must be a non-empty string.`)
  return value
}

function requireSafeInteger(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail('CORRUPTED_STATE', `${label} must be a safe integer.`)
  return value as number
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('CORRUPTED_STATE', `${label} must be boolean.`)
  return value
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('CORRUPTED_STATE', `${label} must be an array.`)
  return value
}

function copyCard(card: Card): Card {
  return Object.freeze({ suit: card.suit, rank: card.rank })
}

function serializeCard(card: Card): JsonRecord {
  if (!SUITS.includes(card?.suit) || !RANKS.includes(card?.rank)) fail('INVALID_STATE', 'State contains an invalid card.')
  return { suit: card.suit, rank: card.rank }
}

function deserializeCard(value: unknown): Card {
  const raw = requireRecord(value, 'Card')
  if (!SUITS.includes(raw.suit as Card['suit']) || !RANKS.includes(raw.rank as Card['rank'])) {
    fail('CORRUPTED_STATE', 'State contains an invalid card.')
  }
  return copyCard({ suit: raw.suit as Card['suit'], rank: raw.rank as Card['rank'] })
}

function serializeCards(cards: readonly Card[]): readonly JsonRecord[] {
  return cards.map(serializeCard)
}

function deserializeCards(value: unknown, label: string): readonly Card[] {
  return Object.freeze(requireArray(value, label).map(deserializeCard))
}

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function assertUniqueCards(cards: readonly Card[], label: string): void {
  const keys = new Set(cards.map(cardKey))
  if (keys.size !== cards.length) fail('CORRUPTED_STATE', `${label} contains duplicate physical cards.`)
}

function serializeDeckSnapshot(deck: InternalHandState['deck']): JsonRecord {
  const snapshot = snapshotDeck(deck)
  return {
    cards: serializeCards(snapshot.cards),
    position: snapshot.position
  }
}

function deserializeDeckSnapshot(value: unknown): InternalHandState['deck'] {
  const raw = requireRecord(value, 'Deck')
  const cards = deserializeCards(raw.cards, 'Deck cards')
  const position = requireSafeInteger(raw.position, 'Deck position')
  if (position > cards.length) fail('CORRUPTED_STATE', 'Deck position exceeds the deck size.')
  try {
    return restoreDeck({ cards, position } satisfies DeckSnapshot)
  } catch (error) {
    fail('CORRUPTED_STATE', error instanceof Error ? error.message : 'Deck snapshot is invalid.')
  }
}

function serializeHand(hand: InternalHandState): JsonRecord {
  if (!hand || !Array.isArray(hand.players)) fail('INVALID_STATE', 'Hand state is invalid.')
  const allKnownCards = hand.players.flatMap(player => player.holeCards).concat(hand.board, hand.burnCards)
  assertUniqueCards(allKnownCards, 'Hand state')
  const availableCards = hand.deck.availableCards
  assertUniqueCards(availableCards, 'Available deck')
  if (allKnownCards.some(card => availableCards.some(other => cardKey(card) === cardKey(other)))) {
    fail('INVALID_STATE', 'A dealt card is still available in the deck.')
  }
  return {
    handId: hand.handId,
    players: hand.players.map(player => ({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      holeCards: serializeCards(player.holeCards),
      contribution: player.contribution,
      streetContribution: player.streetContribution,
      status: player.status,
      lastAction: player.lastAction ?? null
    })),
    dealerSeat: hand.dealerSeat,
    smallBlindSeat: hand.smallBlindSeat,
    bigBlindSeat: hand.bigBlindSeat,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: serializeCards(hand.board),
    street: hand.street,
    pot: hand.pot,
    currentBet: hand.currentBet,
    lastFullRaiseSize: hand.lastFullRaiseSize,
    actedThisRound: [...hand.actedThisRound],
    bettingRoundComplete: hand.bettingRoundComplete,
    currentActor: hand.currentActor,
    deck: serializeDeckSnapshot(hand.deck),
    burnCards: serializeCards(hand.burnCards),
    lastActedAtBet: hand.lastActedAtBet.map(level => ({ playerId: level.playerId, bet: level.bet })),
    actionSummary: (hand.actionSummary ?? []).map(summary => ({ ...summary }))
  }
}

function deserializeHand(value: unknown): InternalHandState {
  const raw = requireRecord(value, 'Hand state')
  const players = requireArray(raw.players, 'Hand players').map(item => {
    const player = requireRecord(item, 'Hand player')
    const holeCards = deserializeCards(player.holeCards, 'Hole cards')
    if (holeCards.length !== 2) fail('CORRUPTED_STATE', 'Each hand player must have exactly two hole cards.')
    if (!HAND_PLAYER_STATUSES.includes(player.status as InternalHandState['players'][number]['status'])) fail('CORRUPTED_STATE', 'Hand player status is invalid.')
    const lastAction = player.lastAction === undefined || player.lastAction === null
      ? undefined
      : HAND_ACTION_TYPES.includes(player.lastAction as typeof HAND_ACTION_TYPES[number])
        ? player.lastAction as typeof HAND_ACTION_TYPES[number]
        : fail('CORRUPTED_STATE', 'Hand player last action is invalid.')
    return Object.freeze({
      playerId: requireString(player.playerId, 'Hand player id'),
      seat: requireSafeInteger(player.seat, 'Hand player seat', 1),
      stack: requireSafeInteger(player.stack, 'Hand player stack'),
      holeCards: Object.freeze(holeCards) as readonly [Card, Card],
      contribution: requireSafeInteger(player.contribution, 'Hand contribution'),
      streetContribution: requireSafeInteger(player.streetContribution, 'Hand street contribution'),
      status: player.status as HandPlayerState['status'],
      ...(lastAction === undefined ? {} : { lastAction })
    })
  })
  const board = deserializeCards(raw.board, 'Board')
  const burnCards = deserializeCards(raw.burnCards, 'Burn cards')
  const deck = deserializeDeckSnapshot(raw.deck)
  const dealtCards = players.flatMap(player => player.holeCards).concat(board, burnCards)
  assertUniqueCards(dealtCards, 'Hand state')
  const fullDeckKeys = new Set(snapshotDeck(deck).cards.map(cardKey))
  if (dealtCards.some(card => !fullDeckKeys.has(cardKey(card)))) {
    fail('CORRUPTED_STATE', 'A dealt card is absent from the deck sequence.')
  }
  if (dealtCards.some(card => deck.availableCards.some(other => cardKey(card) === cardKey(other)))) {
    fail('CORRUPTED_STATE', 'A dealt card is still available in the deck.')
  }
  if (!HAND_STREETS.includes(raw.street as InternalHandState['street'])) fail('CORRUPTED_STATE', 'Hand street is invalid.')
  const lastActedAtBet = requireArray(raw.lastActedAtBet, 'Last action levels').map(item => {
    const level = requireRecord(item, 'Last action level')
    return Object.freeze({ playerId: requireString(level.playerId, 'Last action player id'), bet: requireSafeInteger(level.bet, 'Last action bet') })
  })
  // Older runtime snapshots have no hand-lifetime summary. Recover only facts
  // still represented by their current lastAction; earlier streets cannot be
  // inferred safely and are deliberately not fabricated.
  const actionSummary: HandActionSummary[] = raw.actionSummary === undefined
    ? players.map(player => Object.freeze({
        playerId: player.playerId,
        hadAction: player.lastAction != null,
        hadRaise: player.lastAction === 'bet' || player.lastAction === 'raise',
        hadAllIn: player.lastAction === 'all-in'
      }))
    : requireArray(raw.actionSummary, 'Hand action summary').map(item => {
        const summary = requireRecord(item, 'Hand action summary entry')
        return Object.freeze({
          playerId: requireString(summary.playerId, 'Action summary player id'),
          hadAction: requireBoolean(summary.hadAction, 'Action summary hadAction'),
          hadRaise: requireBoolean(summary.hadRaise, 'Action summary hadRaise'),
          hadAllIn: requireBoolean(summary.hadAllIn, 'Action summary hadAllIn')
        })
      })
  if (actionSummary.length !== players.length
    || new Set(actionSummary.map(summary => summary.playerId)).size !== players.length
    || players.some(player => !actionSummary.some(summary => summary.playerId === player.playerId))) {
    fail('CORRUPTED_STATE', 'Hand action summary does not match the hand players.')
  }
  return Object.freeze({
    handId: requireString(raw.handId, 'Hand id'),
    players: Object.freeze(players),
    dealerSeat: requireSafeInteger(raw.dealerSeat, 'Dealer seat', 1),
    smallBlindSeat: requireSafeInteger(raw.smallBlindSeat, 'Small blind seat', 1),
    bigBlindSeat: requireSafeInteger(raw.bigBlindSeat, 'Big blind seat', 1),
    smallBlind: requireSafeInteger(raw.smallBlind, 'Small blind', 1),
    bigBlind: requireSafeInteger(raw.bigBlind, 'Big blind', 1),
    board,
    street: raw.street as InternalHandState['street'],
    pot: requireSafeInteger(raw.pot, 'Pot'),
    currentBet: requireSafeInteger(raw.currentBet, 'Current bet'),
    lastFullRaiseSize: requireSafeInteger(raw.lastFullRaiseSize, 'Last full raise size'),
    actedThisRound: Object.freeze(requireArray(raw.actedThisRound, 'Acted players').map((id, index) => requireString(id, `Acted player ${index}`))),
    bettingRoundComplete: requireBoolean(raw.bettingRoundComplete, 'Betting round complete'),
    currentActor: raw.currentActor === null ? null : requireSafeInteger(raw.currentActor, 'Current actor', 1),
    deck,
    burnCards,
    lastActedAtBet: Object.freeze(lastActedAtBet) as readonly BetActionLevel[],
    actionSummary: Object.freeze(actionSummary)
  })
}

function serializeFinalizedHand(result: FinalizedHandResult): JsonRecord {
  return {
    handId: result.handId,
    type: result.type,
    reason: result.reason,
    board: serializeCards(result.board),
    players: result.players.map(player => ({
      playerId: player.playerId,
      seat: player.seat,
      status: player.status,
      holeCards: serializeCards(player.holeCards),
      category: player.category,
      categoryRank: player.categoryRank,
      label: player.label,
      contributingCardIds: [...player.contributingCardIds],
      payout: player.payout,
      returnedExcess: player.returnedExcess,
      winner: player.winner
    })),
    pots: result.pots.map(pot => ({
      potId: pot.potId,
      amount: pot.amount,
      winnerIds: [...pot.winnerIds],
      split: pot.split,
      oddChipCount: pot.oddChipCount,
      oddChipRecipients: [...pot.oddChipRecipients],
      payouts: pot.payouts.map(item => ({ playerId: item.playerId, amount: item.amount }))
    })),
    returnedExcess: result.returnedExcess.map(item => ({ playerId: item.playerId, amount: item.amount })),
    totalPayout: result.totalPayout,
    totalReturnedExcess: result.totalReturnedExcess
  }
}

function deserializeFinalizedHand(value: unknown): FinalizedHandResult {
  const raw = requireRecord(value, 'Finalized hand result')
  const players = requireArray(raw.players, 'Finalized players').map(item => {
    const player = requireRecord(item, 'Finalized player')
    const holeCards = deserializeCards(player.holeCards, 'Finalized hole cards')
    if (holeCards.length !== 0 && holeCards.length !== 2) fail('CORRUPTED_STATE', 'Finalized player hole cards must be empty or contain exactly two cards.')
    const category = player.category === null ? null : HAND_CATEGORIES.includes(player.category as typeof HAND_CATEGORIES[number]) ? player.category as typeof HAND_CATEGORIES[number] : fail('CORRUPTED_STATE', 'Finalized hand category is invalid.')
    const categoryRank = player.categoryRank === null ? null : requireSafeInteger(player.categoryRank, 'Finalized category rank')
    const label = player.label === null ? null : requireString(player.label, 'Finalized category label')
    const contributingCardIds = requireArray(player.contributingCardIds, 'Contributing cards').map((id, index) => requireString(id, `Contributing card ${index}`))
    return Object.freeze({
      playerId: requireString(player.playerId, 'Finalized player id'),
      seat: requireSafeInteger(player.seat, 'Finalized player seat', 1),
      status: HAND_PLAYER_STATUSES.includes(player.status as HandPlayerState['status']) ? player.status as HandPlayerState['status'] : fail('CORRUPTED_STATE', 'Finalized player status is invalid.'),
      holeCards: Object.freeze(holeCards),
      category,
      categoryRank,
      label,
      contributingCardIds: Object.freeze(contributingCardIds),
      payout: requireSafeInteger(player.payout, 'Finalized payout'),
      returnedExcess: requireSafeInteger(player.returnedExcess, 'Finalized returned excess'),
      winner: requireBoolean(player.winner, 'Finalized winner')
    })
  })
  const pots = requireArray(raw.pots, 'Finalized pots').map(item => {
    const pot = requireRecord(item, 'Finalized pot')
    const winnerIds = requireArray(pot.winnerIds, 'Finalized winners').map((id, index) => requireString(id, `Winner ${index}`))
    const oddChipRecipients = requireArray(pot.oddChipRecipients, 'Odd-chip recipients').map((id, index) => requireString(id, `Odd-chip recipient ${index}`))
    const payouts = requireArray(pot.payouts, 'Finalized payouts').map(item => {
      const payout = requireRecord(item, 'Finalized payout')
      return Object.freeze({ playerId: requireString(payout.playerId, 'Finalized payout player id'), amount: requireSafeInteger(payout.amount, 'Finalized payout amount') })
    })
    return Object.freeze({
      potId: requireSafeInteger(pot.potId, 'Finalized pot id', 1),
      amount: requireSafeInteger(pot.amount, 'Finalized pot amount', 1),
      winnerIds: Object.freeze(winnerIds),
      split: requireBoolean(pot.split, 'Finalized pot split'),
      oddChipCount: requireSafeInteger(pot.oddChipCount, 'Finalized odd-chip count'),
      oddChipRecipients: Object.freeze(oddChipRecipients),
      payouts: Object.freeze(payouts)
    })
  })
  const returnedExcess = requireArray(raw.returnedExcess, 'Finalized returned excess').map(item => {
    const returned = requireRecord(item, 'Finalized returned excess')
    return Object.freeze({ playerId: requireString(returned.playerId, 'Returned-excess player id'), amount: requireSafeInteger(returned.amount, 'Returned-excess amount') })
  })
  if (raw.type !== 'CONTESTED' && raw.type !== 'UNCONTESTED') fail('CORRUPTED_STATE', 'Finalized hand type is invalid.')
  if (raw.reason !== 'SHOWDOWN' && raw.reason !== 'UNCONTESTED_FOLD') fail('CORRUPTED_STATE', 'Finalized hand reason is invalid.')
  return Object.freeze({
    handId: requireString(raw.handId, 'Finalized hand id'),
    type: raw.type,
    reason: raw.reason,
    board: deserializeCards(raw.board, 'Finalized board'),
    players: Object.freeze(players),
    pots: Object.freeze(pots),
    returnedExcess: Object.freeze(returnedExcess),
    totalPayout: requireSafeInteger(raw.totalPayout, 'Finalized total payout'),
    totalReturnedExcess: requireSafeInteger(raw.totalReturnedExcess, 'Finalized total returned excess')
  })
}

function serializeTable(table: PokerTableState): JsonRecord {
  if (!table || !Array.isArray(table.players) || !Array.isArray(table.seats)) fail('INVALID_STATE', 'Table state is invalid.')
  return {
    tableId: table.tableId,
    maxPlayers: table.maxPlayers,
    seats: table.seats.map(seat => ({ seat: seat.seat, playerId: seat.playerId })),
    players: table.players.map(player => ({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      connected: player.connected,
      ready: player.ready,
      sittingOut: player.sittingOut
    })),
    currentHand: table.currentHand ? serializeHand(table.currentHand) : null,
    dealerSeat: table.dealerSeat,
    status: table.status,
    stateVersion: table.stateVersion,
    handSequence: table.handSequence,
    finalizedHandId: table.finalizedHandId,
    finalizedHand: table.finalizedHand ? serializeFinalizedHand(table.finalizedHand) : null,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind
  }
}

function deserializeTable(value: unknown): PokerTableState {
  const raw = requireRecord(value, 'Table state')
  if (raw.maxPlayers !== MAX_TABLE_PLAYERS || !TABLE_STATUSES.includes(raw.status as PokerTableState['status'])) fail('CORRUPTED_STATE', 'Table metadata is invalid.')
  const players = requireArray(raw.players, 'Table players').map(item => {
    const player = requireRecord(item, 'Table player')
    return Object.freeze({
      playerId: requireString(player.playerId, 'Table player id'),
      seat: requireSafeInteger(player.seat, 'Table player seat', 1),
      stack: requireSafeInteger(player.stack, 'Table player stack'),
      connected: requireBoolean(player.connected, 'Table player connected'),
      ready: requireBoolean(player.ready, 'Table player ready'),
      sittingOut: requireBoolean(player.sittingOut, 'Table player sitting out')
    })
  })
  const seats = requireArray(raw.seats, 'Table seats').map(item => {
    const seat = requireRecord(item, 'Table seat')
    return Object.freeze({
      seat: requireSafeInteger(seat.seat, 'Table seat number', 1),
      playerId: seat.playerId === null ? null : requireString(seat.playerId, 'Table seat player id')
    })
  })
  if (players.length > MAX_TABLE_PLAYERS || seats.length !== MAX_TABLE_PLAYERS) fail('CORRUPTED_STATE', 'Table player or seat count is invalid.')
  const playerIds = new Set(players.map(player => player.playerId))
  const playerSeats = new Set(players.map(player => player.seat))
  if (playerIds.size !== players.length || playerSeats.size !== players.length || [...playerSeats].some(seat => seat > MAX_TABLE_PLAYERS)) {
    fail('CORRUPTED_STATE', 'Table players contain duplicate or invalid seats.')
  }
  const seatNumbers = new Set(seats.map(seat => seat.seat))
  if (seatNumbers.size !== MAX_TABLE_PLAYERS || [...seatNumbers].some(seat => seat > MAX_TABLE_PLAYERS)) fail('CORRUPTED_STATE', 'Table seats are invalid.')
  for (const seat of seats) {
    if (seat.playerId !== null && !playerIds.has(seat.playerId)) fail('CORRUPTED_STATE', 'Table seat references an unknown player.')
    if (seat.playerId !== null && !playerSeats.has(seat.seat)) fail('CORRUPTED_STATE', 'Table seat mapping is inconsistent.')
  }
  const currentHand = raw.currentHand === null ? null : deserializeHand(raw.currentHand)
  return Object.freeze({
    tableId: requireString(raw.tableId, 'Table id'),
    maxPlayers: MAX_TABLE_PLAYERS,
    seats: Object.freeze(seats),
    players: Object.freeze(players),
    currentHand,
    dealerSeat: raw.dealerSeat === null ? null : requireSafeInteger(raw.dealerSeat, 'Table dealer seat', 1),
    status: raw.status as PokerTableState['status'],
    stateVersion: requireSafeInteger(raw.stateVersion, 'Table state version'),
    handSequence: requireSafeInteger(raw.handSequence, 'Table hand sequence'),
    finalizedHandId: raw.finalizedHandId === undefined || raw.finalizedHandId === null
      ? null
      : requireString(raw.finalizedHandId, 'Finalized hand id'),
    finalizedHand: raw.finalizedHand === undefined || raw.finalizedHand === null
      ? null
      : deserializeFinalizedHand(raw.finalizedHand),
    smallBlind: requireSafeInteger(raw.smallBlind, 'Table small blind', 1),
    bigBlind: requireSafeInteger(raw.bigBlind, 'Table big blind', 1)
  })
}

function serializeState(state: OnlineRoomState): JsonRecord {
  if (!state || state.type !== ONLINE_ROOM_TYPE) fail('INVALID_STATE', 'Online room state is invalid.')
  if (state.maxPlayers !== ONLINE_ROOM_MAX_PLAYERS) fail('INVALID_STATE', 'Online room player limit is invalid.')
  if (!ONLINE_ROOM_VISIBILITIES.includes(state.visibility) || !ONLINE_ROOM_STATUSES.includes(state.status)) fail('INVALID_STATE', 'Online room metadata is invalid.')
  return {
    roomId: state.roomId,
    roomCode: state.roomCode,
    type: state.type,
    visibility: state.visibility,
    ownerId: state.ownerId,
    status: state.status,
    createdAt: state.createdAt,
    maxPlayers: state.maxPlayers,
    pokerTable: serializeTable(state.pokerTable),
    roomVersion: state.roomVersion,
    turnDeadlineAt: state.turnDeadlineAt,
    pendingLeaves: [...state.pendingLeaves],
    ...(state.privateJoinSecret === undefined ? {} : { privateJoinSecret: state.privateJoinSecret })
  }
}

function deserializeState(value: unknown): OnlineRoomState {
  const raw = requireRecord(value, 'Online room state')
  if (raw.type !== ONLINE_ROOM_TYPE || !ONLINE_ROOM_VISIBILITIES.includes(raw.visibility as OnlineRoomState['visibility']) || !ONLINE_ROOM_STATUSES.includes(raw.status as OnlineRoomState['status'])) {
    fail('CORRUPTED_STATE', 'Online room metadata is invalid.')
  }
  if (raw.maxPlayers !== ONLINE_ROOM_MAX_PLAYERS) fail('CORRUPTED_STATE', 'Online room player limit is invalid.')
  const privateJoinSecret = raw.privateJoinSecret === undefined ? undefined : requireString(raw.privateJoinSecret, 'Private room secret')
  if (raw.visibility === 'PUBLIC' && privateJoinSecret !== undefined) fail('CORRUPTED_STATE', 'Public room state contains a private secret.')
  return Object.freeze({
    roomId: requireString(raw.roomId, 'Room id'),
    roomCode: requireString(raw.roomCode, 'Room code'),
    type: ONLINE_ROOM_TYPE,
    visibility: raw.visibility as OnlineRoomState['visibility'],
    ownerId: raw.ownerId === null ? null : requireString(raw.ownerId, 'Owner id'),
    status: raw.status as OnlineRoomState['status'],
    createdAt: requireString(raw.createdAt, 'Created-at timestamp'),
    maxPlayers: ONLINE_ROOM_MAX_PLAYERS,
    pokerTable: deserializeTable(raw.pokerTable),
    roomVersion: requireSafeInteger(raw.roomVersion, 'Room version'),
    turnDeadlineAt: raw.turnDeadlineAt === null || raw.turnDeadlineAt === undefined
      ? null
      : requireSafeInteger(raw.turnDeadlineAt, 'Turn deadline', 1),
    pendingLeaves: Object.freeze(requireArray(raw.pendingLeaves, 'Pending leaves').map((id, index) => requireString(id, `Pending leave ${index}`))),
    ...(privateJoinSecret === undefined ? {} : { privateJoinSecret })
  })
}

function encodeEnvelope(state: OnlineRoomState, runtimeRevision: number): string {
  const envelope: SerializedRuntimeEnvelope = {
    schemaVersion: ONLINE_ROOM_RUNTIME_SCHEMA_VERSION,
    runtimeRevision,
    state: serializeState(state)
  }
  return JSON.stringify(envelope)
}

function decodeEnvelope(payload: string, roomId: string): OnlineRoomRuntimeRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    fail('CORRUPTED_STATE', 'Redis runtime payload is not valid JSON.')
  }
  const raw = requireRecord(parsed, 'Runtime envelope')
  if (raw.schemaVersion !== ONLINE_ROOM_RUNTIME_SCHEMA_VERSION) fail('CORRUPTED_STATE', 'Redis runtime schema version is unsupported.')
  const runtimeRevision = requireSafeInteger(raw.runtimeRevision, 'Runtime revision', 1)
  const state = deserializeState(raw.state)
  if (state.roomId !== roomId) fail('CORRUPTED_STATE', 'Redis runtime key does not match the room state.')
  return Object.freeze({ state, runtimeRevision })
}

function redisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  } as const
}

async function connectRedis(client: Redis): Promise<void> {
  try {
    if (client.status === 'wait' || client.status === 'end') await client.connect()
    if (client.status !== 'ready') throw new Error('Redis is not ready')
  } catch (error) {
    throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis is unavailable.')
  }
}

function validTtl(value: number | undefined): number {
  const ttl = value ?? ONLINE_ROOM_RUNTIME_DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 30 * 24 * 60 * 60) throw new OnlineRoomRuntimeStoreError('INVALID_ARGUMENT', 'Runtime TTL must be between 60 seconds and 30 days.')
  return ttl
}

function actionKeyPart(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new OnlineRoomRuntimeStoreError('INVALID_ARGUMENT', `${label} must be a non-empty bounded string.`)
  }
  return createHash('sha256').update(value).digest('hex')
}

function encodeActionRecord(record: SerializedActionRecord): string {
  return JSON.stringify(record)
}

function decodeActionRecord(payload: string): SerializedActionRecord {
  try {
    const value = JSON.parse(payload) as Partial<SerializedActionRecord>
    const runtimeRevision = value.runtimeRevision
    if (typeof value.fingerprint !== 'string' || value.fingerprint.length === 0 || value.fingerprint.length > 512 ||
        !Number.isSafeInteger(runtimeRevision) || (runtimeRevision as number) < 1) throw new Error('Invalid action record.')
    return { fingerprint: value.fingerprint, runtimeRevision: runtimeRevision as number }
  } catch {
    fail('CORRUPTED_STATE', 'Redis action record is invalid.')
  }
}

function hasActiveHand(state: OnlineRoomState): boolean {
  return state.pokerTable.currentHand !== null && state.pokerTable.currentHand.street !== 'FINISHED'
}

function expiryArgs(state: OnlineRoomState, ttlSeconds: number): ['EX', number] | [] {
  // A seated player may hold real wallet-funded chips even between hands or
  // after a finished hand. Keep that runtime until the last seat is cashed out.
  return hasActiveHand(state) || state.pokerTable.players.length > 0 ? [] : ['EX', ttlSeconds]
}

export function onlineRoomRuntimeKey(roomId: string, keyPrefix = ONLINE_ROOM_RUNTIME_KEY_PREFIX): string {
  if (typeof roomId !== 'string' || roomId.trim().length === 0) throw new OnlineRoomRuntimeStoreError('INVALID_ARGUMENT', 'Room id is required.')
  return `${keyPrefix}${roomId}`
}

/** Redis-backed authoritative runtime state. No process-local copy is used for reads or writes. */
export class OnlineRoomRuntimeStore {
  private readonly redis: Redis
  private readonly ownsRedis: boolean
  private readonly keyPrefix: string
  private readonly ttlSeconds: number
  private readonly actionTtlSeconds: number
  private connecting: Promise<void> | undefined
  private fundedRuntimeSweep: Promise<void> | undefined

  constructor(options: OnlineRoomRuntimeStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? ONLINE_ROOM_RUNTIME_KEY_PREFIX
    this.ttlSeconds = validTtl(options.ttlSeconds)
    this.actionTtlSeconds = validTtl(options.actionTtlSeconds ?? ONLINE_ROOM_ACTION_DEFAULT_TTL_SECONDS)
    if (options.redis) {
      this.redis = options.redis
      this.ownsRedis = false
    } else {
      if (!options.redisUrl && !process.env.REDIS_URL) {
        throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', 'REDIS_URL is required for online room runtime state.')
      }
      this.redis = new Redis(options.redisUrl ?? process.env.REDIS_URL!, redisOptions())
      this.ownsRedis = true
    }
    if (this.ownsRedis) this.redis.on('error', () => {})
  }

  async connect(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined })
        await this.connecting
      } else if (this.redis.status === 'connecting' && this.connecting) {
        await this.connecting
      }
      if (this.redis.status !== 'ready') throw new Error('Redis is not ready')
      this.fundedRuntimeSweep ??= this.preserveFundedRuntimeKeys().catch(error => {
        this.fundedRuntimeSweep = undefined
        throw error
      })
      await this.fundedRuntimeSweep
    } catch (error) {
      throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis is unavailable.')
    }
  }

  /** Removes legacy TTLs from already funded rooms when deploying the no-expiry policy. */
  private async preserveFundedRuntimeKeys(): Promise<void> {
    let cursor = '0'
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${this.keyPrefix}*`, 'COUNT', 200)
      cursor = nextCursor
      for (const key of keys) {
        const roomId = key.slice(this.keyPrefix.length)
        if (!roomId || roomId.includes(':')) continue
        const payload = await this.redis.get(key)
        if (payload === null) continue
        try {
          const record = decodeEnvelope(payload, roomId)
          if (record.state.pokerTable.players.length > 0) await this.redis.persist(key)
        } catch {
          // Leave malformed values untouched for the normal controlled error path.
        }
      }
    } while (cursor !== '0')
  }

  async disconnect(): Promise<void> {
    if (this.ownsRedis) this.redis.disconnect()
  }

  private key(roomId: string): string {
    return onlineRoomRuntimeKey(roomId, this.keyPrefix)
  }

  private actionKey(roomId: string, playerId: string, actionId: string): string {
    return `${this.key(roomId)}:action:${actionKeyPart(playerId, 'Player id')}:${actionKeyPart(actionId, 'Action id')}`
  }

  /** Server-side diagnostic helper for tests and operational cleanup only. */
  keyFor(roomId: string): string {
    return this.key(roomId)
  }

  async create(state: OnlineRoomState, fence?: OnlineRoomMutationFence): Promise<OnlineRoomRuntimeRecord> {
    const runtimeRevision = 1
    const key = this.key(state.roomId)
    const payload = encodeEnvelope(state, runtimeRevision)
    try {
      await this.connect()
      const expiry = expiryArgs(state, this.ttlSeconds)
      let result: string | null
      if (fence) {
        const fencedResult = Number(await this.redis.eval(`
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
            if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
            ${expiry.length === 0 ? "redis.call('SET', KEYS[2], ARGV[2])" : "redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])"}
            return 1
          `, 2, fence.key, key, fence.token, payload, ...(expiry.length === 0 ? [] : [expiry[1]])))
        if (fencedResult === -1) fail('STALE_STATE', 'The bot worker lease is no longer valid.')
        result = fencedResult === 1 ? 'OK' : null
      } else {
        result = expiry.length === 0
          ? await this.redis.set(key, payload, 'NX')
          : await this.redis.set(key, payload, expiry[0], expiry[1], 'NX')
      }
      if (result !== 'OK') fail('ROOM_EXISTS', `Runtime state for room ${state.roomId} already exists.`)
      return Object.freeze({ state, runtimeRevision })
    } catch (error) {
      if (error instanceof OnlineRoomRuntimeStoreError) throw error
      throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis write failed.')
    }
  }

  async get(roomId: string): Promise<OnlineRoomRuntimeRecord | null> {
    const key = this.key(roomId)
    try {
      await this.connect()
      const payload = await this.redis.get(key)
      if (payload === null) return null
      const record = decodeEnvelope(payload, roomId)
      if (hasActiveHand(record.state) || record.state.pokerTable.players.length > 0) await this.redis.persist(key)
      else await this.redis.expire(key, this.ttlSeconds)
      return record
    } catch (error) {
      if (error instanceof OnlineRoomRuntimeStoreError) throw error
      throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis read failed.')
    }
  }

  async update(roomId: string, expectedRevision: number, updater: (state: OnlineRoomState) => OnlineRoomState, fence?: OnlineRoomMutationFence): Promise<OnlineRoomRuntimeRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('INVALID_ARGUMENT', 'Expected runtime revision must be a positive integer.')
    if (typeof updater !== 'function') fail('INVALID_ARGUMENT', 'A controlled runtime updater is required.')
    const key = this.key(roomId)
    const transactionRedis = this.redis.duplicate()
    transactionRedis.on('error', () => {})
    let updaterFailure: unknown
    try {
      await connectRedis(transactionRedis)
      await transactionRedis.watch(...(fence ? [key, fence.key] : [key]))
      try {
        const payload = await transactionRedis.get(key)
        if (payload === null) fail('ROOM_NOT_FOUND', `Runtime state for room ${roomId} was not found.`)
        const current = decodeEnvelope(payload, roomId)
        if (fence && await transactionRedis.get(fence.key) !== fence.token) fail('STALE_STATE', 'The bot worker lease is no longer valid.')
        if (current.runtimeRevision !== expectedRevision) fail('STALE_STATE', `Expected runtime revision ${expectedRevision} does not match ${current.runtimeRevision}.`)
        let nextState: OnlineRoomState
        try {
          nextState = updater(current.state)
        } catch (error) {
          updaterFailure = error
          throw error
        }
        if (!nextState || nextState.roomId !== roomId) fail('INVALID_STATE', 'Runtime updater returned an invalid room state.')
        const next = Object.freeze({ state: nextState, runtimeRevision: current.runtimeRevision + 1 })
        const expiry = expiryArgs(nextState, this.ttlSeconds)
        const command = expiry.length === 0
          ? transactionRedis.multi().set(key, encodeEnvelope(nextState, next.runtimeRevision))
          : transactionRedis.multi().set(key, encodeEnvelope(nextState, next.runtimeRevision), expiry[0], expiry[1])
        const result = await command.exec()
        if (result === null) fail('STALE_STATE', 'Runtime state changed while the update was being written.')
        return next
      } finally {
        await transactionRedis.unwatch().catch(() => undefined)
      }
    } catch (error) {
      if (updaterFailure !== undefined) throw updaterFailure
      if (error instanceof OnlineRoomRuntimeStoreError) throw error
      throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis update failed.')
    } finally {
      transactionRedis.disconnect()
    }
  }

  /**
   * Applies a mutation and records its client action id in the same Redis CAS.
   * This keeps duplicate commands idempotent across application instances.
   */
  async updateWithAction(
    roomId: string,
    expectedRevision: number,
    playerId: string,
    actionId: string,
    fingerprint: string,
    updater: (state: OnlineRoomState) => OnlineRoomState,
    fence?: OnlineRoomMutationFence
  ): Promise<OnlineRoomActionMutationResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('INVALID_ARGUMENT', 'Expected runtime revision must be a positive integer.')
    if (typeof updater !== 'function') fail('INVALID_ARGUMENT', 'A controlled runtime updater is required.')
    if (typeof fingerprint !== 'string' || fingerprint.length === 0 || fingerprint.length > 512) fail('INVALID_ARGUMENT', 'Action fingerprint is invalid.')
    const key = this.key(roomId)
    const actionKey = this.actionKey(roomId, playerId, actionId)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transactionRedis = this.redis.duplicate()
      transactionRedis.on('error', () => {})
      let updaterFailure: unknown
      try {
        await connectRedis(transactionRedis)
        await transactionRedis.watch(...(fence ? [key, actionKey, fence.key] : [key, actionKey]))
        try {
          const payload = await transactionRedis.get(key)
          if (payload === null) fail('ROOM_NOT_FOUND', `Runtime state for room ${roomId} was not found.`)
          const current = decodeEnvelope(payload, roomId)
          if (fence && await transactionRedis.get(fence.key) !== fence.token) fail('STALE_STATE', 'The bot worker lease is no longer valid.')
          const existingPayload = await transactionRedis.get(actionKey)
          if (existingPayload !== null) {
            const existing = decodeActionRecord(existingPayload)
            if (existing.fingerprint !== fingerprint) fail('ACTION_CONFLICT', 'The action id was already used with a different payload.')
            return Object.freeze({ record: current, duplicate: true })
          }
          if (current.runtimeRevision !== expectedRevision) fail('STALE_STATE', `Expected runtime revision ${expectedRevision} does not match ${current.runtimeRevision}.`)
          let nextState: OnlineRoomState
          try {
            nextState = updater(current.state)
          } catch (error) {
            updaterFailure = error
            throw error
          }
          if (!nextState || nextState.roomId !== roomId) fail('INVALID_STATE', 'Runtime updater returned an invalid room state.')
          const next = Object.freeze({ state: nextState, runtimeRevision: current.runtimeRevision + 1 })
          const expiry = expiryArgs(nextState, this.ttlSeconds)
          const command = expiry.length === 0
            ? transactionRedis.multi()
                .set(key, encodeEnvelope(nextState, next.runtimeRevision))
                .set(actionKey, encodeActionRecord({ fingerprint, runtimeRevision: next.runtimeRevision }), 'EX', this.actionTtlSeconds)
            : transactionRedis.multi()
                .set(key, encodeEnvelope(nextState, next.runtimeRevision), expiry[0], expiry[1])
                .set(actionKey, encodeActionRecord({ fingerprint, runtimeRevision: next.runtimeRevision }), 'EX', this.actionTtlSeconds)
          const result = await command.exec()
          if (result === null) {
            if (attempt === 0) continue
            fail('STALE_STATE', 'Runtime state changed while the action was being written.')
          }
          return Object.freeze({ record: next, duplicate: false })
        } finally {
          await transactionRedis.unwatch().catch(() => undefined)
        }
      } catch (error) {
        if (updaterFailure !== undefined) throw updaterFailure
        if (error instanceof OnlineRoomRuntimeStoreError) throw error
        throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis action update failed.')
      } finally {
        transactionRedis.disconnect()
      }
    }
    fail('STALE_STATE', 'Runtime state changed while the action was being written.')
  }

  async remove(roomId: string, expectedRevision: number): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail('INVALID_ARGUMENT', 'Expected runtime revision must be a positive integer.')
    const key = this.key(roomId)
    const transactionRedis = this.redis.duplicate()
    transactionRedis.on('error', () => {})
    try {
      await connectRedis(transactionRedis)
      await transactionRedis.watch(key)
      try {
        const payload = await transactionRedis.get(key)
        if (payload === null) fail('ROOM_NOT_FOUND', `Runtime state for room ${roomId} was not found.`)
        const current = decodeEnvelope(payload, roomId)
        if (current.runtimeRevision !== expectedRevision) fail('STALE_STATE', `Expected runtime revision ${expectedRevision} does not match ${current.runtimeRevision}.`)
        const result = await transactionRedis.multi().del(key).exec()
        if (result === null) fail('STALE_STATE', 'Runtime state changed while it was being removed.')
      } finally {
        await transactionRedis.unwatch().catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof OnlineRoomRuntimeStoreError) throw error
      throw new OnlineRoomRuntimeStoreError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis removal failed.')
    } finally {
      transactionRedis.disconnect()
    }
  }

  async close(roomId: string, expectedRevision: number): Promise<void> {
    return this.remove(roomId, expectedRevision)
  }
}

export function serializeOnlineRoomRuntimeState(state: OnlineRoomState): string {
  return encodeEnvelope(state, 1)
}

export function deserializeOnlineRoomRuntimeState(payload: string, roomId: string): OnlineRoomRuntimeRecord {
  return decodeEnvelope(payload, roomId)
}
