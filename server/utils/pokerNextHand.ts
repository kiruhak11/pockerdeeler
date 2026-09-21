import { createShuffledDeck, type Deck } from './pokerDeck'
import { startHand, type HandPlayerStatus, type HandStartPlayer, type InternalHandState } from './pokerHandState'

/**
 * The small table-level input needed to start another hand.  The current
 * engine has no room/session model, so activity is intentionally represented
 * by two optional flags rather than by inventing a larger table state.
 */
export type NextHandPlayer = Readonly<{
  playerId: string
  seat: number
  stack: number
  /** Historical status is accepted as input but deliberately reset by startHand. */
  status?: HandPlayerStatus
  active?: boolean
  sittingOut?: boolean
}>

export type PrepareNextHandOptions = Readonly<{
  players: readonly NextHandPlayer[]
  previousDealerSeat?: number
  smallBlind: number
  bigBlind: number
  /** Optional predefined deck for deterministic tests. */
  deck?: Deck
}>

export type NextHandStarted = Readonly<{
  status: 'STARTED'
  hand: InternalHandState
  eligiblePlayers: readonly HandStartPlayer[]
}>

export type NextHandWaiting = Readonly<{
  status: 'WAITING'
  reason: 'NOT_ENOUGH_PLAYERS'
  hand: null
  eligiblePlayers: readonly HandStartPlayer[]
}>

export type PrepareNextHandResult = NextHandStarted | NextHandWaiting

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
}

function validateOptions(options: PrepareNextHandOptions): void {
  if (!options || !Array.isArray(options.players)) throw new Error('Next hand requires a players list.')
  if (options.previousDealerSeat !== undefined) {
    assertPositiveInteger(options.previousDealerSeat, 'Previous dealer seat')
  }
  assertPositiveInteger(options.smallBlind, 'Small blind')
  assertPositiveInteger(options.bigBlind, 'Big blind')
  if (options.bigBlind < options.smallBlind) {
    throw new Error('Big blind must be greater than or equal to small blind.')
  }

  const playerIds = new Set<string>()
  const seats = new Set<number>()
  for (const player of options.players) {
    if (typeof player.playerId !== 'string' || player.playerId.trim().length === 0) {
      throw new Error('Player id must be a non-empty string.')
    }
    if (playerIds.has(player.playerId)) throw new Error('Player ids must be unique.')
    playerIds.add(player.playerId)

    assertPositiveInteger(player.seat, 'Seat')
    if (seats.has(player.seat)) throw new Error('Seats must be unique.')
    seats.add(player.seat)
    assertNonNegativeInteger(player.stack, `Stack for ${player.playerId}`)

    if (player.active !== undefined && typeof player.active !== 'boolean') {
      throw new Error(`Active flag for ${player.playerId} must be boolean.`)
    }
    if (player.sittingOut !== undefined && typeof player.sittingOut !== 'boolean') {
      throw new Error(`Sitting-out flag for ${player.playerId} must be boolean.`)
    }
  }
}

function isEligible(player: NextHandPlayer): boolean {
  return player.stack > 0 && player.active !== false && player.sittingOut !== true
}

function startPlayers(players: readonly NextHandPlayer[]): readonly HandStartPlayer[] {
  return Object.freeze(players.filter(isEligible).map(player => Object.freeze({
    playerId: player.playerId,
    seat: player.seat,
    stack: player.stack
  })))
}

/**
 * Prepares the next server-owned hand from the previous hand's final stacks.
 * The existing startHand implementation remains the single authority for
 * button positions, blinds, dealing and initial action order.
 */
export function prepareNextHand(options: PrepareNextHandOptions): PrepareNextHandResult {
  validateOptions(options)
  const eligiblePlayers = startPlayers(options.players)
  if (eligiblePlayers.length < 2) {
    return Object.freeze({
      status: 'WAITING' as const,
      reason: 'NOT_ENOUGH_PLAYERS' as const,
      hand: null,
      eligiblePlayers
    })
  }

  const hand = startHand({
    players: eligiblePlayers,
    previousDealerSeat: options.previousDealerSeat,
    smallBlind: options.smallBlind,
    bigBlind: options.bigBlind,
    // A new secure deck is used for every production hand. Tests may inject
    // a predefined deck without reusing the previous hand's deck instance.
    deck: options.deck ?? createShuffledDeck()
  })

  return Object.freeze({
    status: 'STARTED' as const,
    hand,
    eligiblePlayers
  })
}
