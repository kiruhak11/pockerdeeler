import { randomUUID } from 'node:crypto'
import { createShuffledDeck, type Card, type Deck } from './pokerDeck'

export const HAND_STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'FINISHED'] as const
export type HandStreet = typeof HAND_STREETS[number]

export const HAND_PLAYER_STATUSES = ['ACTIVE', 'ALL_IN', 'FOLDED', 'OUT'] as const
export type HandPlayerStatus = typeof HAND_PLAYER_STATUSES[number]

export type HandStartPlayer = Readonly<{
  playerId: string
  seat: number
  stack: number
}>

export type HandPlayerState = Readonly<{
  playerId: string
  seat: number
  stack: number
  holeCards: readonly [Card, Card]
  contribution: number
  streetContribution: number
  status: HandPlayerStatus
}>

export type HandState = Readonly<{
  handId: string
  players: readonly HandPlayerState[]
  dealerSeat: number
  smallBlindSeat: number
  bigBlindSeat: number
  smallBlind: number
  bigBlind: number
  board: readonly Card[]
  street: HandStreet
  pot: number
  currentBet: number
  lastFullRaiseSize: number
  actedThisRound: readonly string[]
  bettingRoundComplete: boolean
  currentActor: number | null
}>

export type InternalHandState = HandState & Readonly<{
  deck: Deck
}>

export type PlayerSafeHandPlayer = Readonly<Omit<HandPlayerState, 'holeCards'> & {
  holeCards: readonly Card[]
}>

export type PlayerSafeHandState = Readonly<Omit<HandState, 'players'> & {
  players: readonly PlayerSafeHandPlayer[]
}>

export type StartHandOptions = Readonly<{
  players: readonly HandStartPlayer[]
  smallBlind: number
  bigBlind: number
  previousDealerSeat?: number
  deck?: Deck
}>

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
}

function sortedSeats(players: readonly Pick<HandStartPlayer, 'seat'>[]): number[] {
  const seats = players.map(player => player.seat)
  for (const seat of seats) assertPositiveInteger(seat, 'Seat')
  if (new Set(seats).size !== seats.length) throw new Error('Seats must be unique.')
  return [...seats].sort((left, right) => left - right)
}

function validatePlayers(players: readonly HandStartPlayer[]): number[] {
  if (players.length < 2) throw new Error('A hand requires at least 2 players.')
  if (players.length > 6) throw new Error('A hand supports at most 6 players.')

  const playerIds = new Set<string>()
  for (const player of players) {
    if (typeof player.playerId !== 'string' || player.playerId.trim().length === 0) {
      throw new Error('Player id must be a non-empty string.')
    }
    if (playerIds.has(player.playerId)) throw new Error('Player ids must be unique.')
    playerIds.add(player.playerId)
    assertPositiveInteger(player.stack, 'Stack')
  }
  return sortedSeats(players)
}

function nextSeat(seats: readonly number[], fromSeat: number): number {
  const next = seats.find(seat => seat > fromSeat)
  return next ?? seats[0]!
}

function orderedSeatsFrom(seats: readonly number[], firstSeat: number): number[] {
  const firstIndex = seats.indexOf(firstSeat)
  if (firstIndex < 0) throw new Error(`Seat ${firstSeat} is not participating in this hand.`)
  return seats.slice(firstIndex).concat(seats.slice(0, firstIndex))
}

/**
 * Selects the first seat for a new button when no previous button exists,
 * otherwise advances clockwise and naturally skips omitted players.
 */
export function nextDealerSeat(players: readonly Pick<HandStartPlayer, 'seat'>[], previousDealerSeat?: number): number {
  const seats = sortedSeats(players)
  if (seats.length === 0) throw new Error('Cannot choose a dealer without participating seats.')
  if (previousDealerSeat === undefined) return seats[0]!
  assertPositiveInteger(previousDealerSeat, 'Previous dealer seat')
  return nextSeat(seats, previousDealerSeat)
}

function postBlind(player: HandPlayerState, blind: number): HandPlayerState {
  const amount = Math.min(player.stack, blind)
  const stack = player.stack - amount
  return Object.freeze({
    ...player,
    stack,
    contribution: amount,
    streetContribution: amount,
    status: stack === 0 ? 'ALL_IN' : 'ACTIVE'
  })
}

function findFirstActor(players: readonly HandPlayerState[], startSeat: number): number | null {
  const seats = players.map(player => player.seat).sort((left, right) => left - right)
  for (const seat of orderedSeatsFrom(seats, startSeat)) {
    const player = players.find(candidate => candidate.seat === seat)
    if (player?.status === 'ACTIVE' && player.stack > 0) return player.seat
  }
  return null
}

/** Starts a new preflop hand with blinds posted and two cards dealt per player. */
export function startHand(options: StartHandOptions): InternalHandState {
  const { players, smallBlind, bigBlind } = options
  const seats = validatePlayers(players)
  assertPositiveInteger(smallBlind, 'Small blind')
  assertPositiveInteger(bigBlind, 'Big blind')
  if (bigBlind < smallBlind) throw new Error('Big blind must be greater than or equal to small blind.')

  const dealerSeat = nextDealerSeat(players, options.previousDealerSeat)
  const headsUp = seats.length === 2
  const smallBlindSeat = headsUp ? dealerSeat : nextSeat(seats, dealerSeat)
  const bigBlindSeat = headsUp ? nextSeat(seats, dealerSeat) : nextSeat(seats, smallBlindSeat)
  const deck = options.deck ?? createShuffledDeck()
  if (deck.remainingCount < players.length * 2) {
    throw new Error('The deck does not contain enough cards for this hand.')
  }

  const workingPlayers = new Map<number, HandPlayerState>()
  for (const player of players) {
    const state: HandPlayerState = Object.freeze({
      playerId: player.playerId,
      seat: player.seat,
      stack: player.stack,
      holeCards: [] as unknown as readonly [Card, Card],
      contribution: 0,
      streetContribution: 0,
      status: 'ACTIVE'
    })
    workingPlayers.set(player.seat, state)
  }

  const smallBlindPlayer = workingPlayers.get(smallBlindSeat)!
  workingPlayers.set(smallBlindSeat, postBlind(smallBlindPlayer, smallBlind))
  const bigBlindPlayer = workingPlayers.get(bigBlindSeat)!
  workingPlayers.set(bigBlindSeat, postBlind(bigBlindPlayer, bigBlind))

  const dealOrder = orderedSeatsFrom(seats, headsUp ? dealerSeat : smallBlindSeat)
  const dealtCards = new Map<number, Card[]>()
  for (const seat of seats) dealtCards.set(seat, [])
  for (let pass = 0; pass < 2; pass += 1) {
    for (const seat of dealOrder) dealtCards.get(seat)!.push(deck.deal())
  }

  const handPlayers = seats.map(seat => {
    const player = workingPlayers.get(seat)!
    const holeCards = dealtCards.get(seat)!
    const completed = Object.freeze({
      ...player,
      holeCards: Object.freeze([holeCards[0]!, holeCards[1]!]) as readonly [Card, Card]
    })
    return completed
  })

  const actorStart = headsUp ? dealerSeat : nextSeat(seats, bigBlindSeat)
  const pot = handPlayers.reduce((total, player) => total + player.contribution, 0)
  const currentBet = Math.max(...handPlayers.map(player => player.streetContribution), 0)
  const currentActor = findFirstActor(handPlayers, actorStart)
  const state: InternalHandState = Object.freeze({
    handId: randomUUID(),
    players: Object.freeze(handPlayers),
    dealerSeat,
    smallBlindSeat,
    bigBlindSeat,
    smallBlind,
    bigBlind,
    board: Object.freeze([]),
    street: 'PREFLOP',
    pot,
    currentBet,
    lastFullRaiseSize: bigBlind,
    actedThisRound: Object.freeze([]),
    bettingRoundComplete: currentActor === null,
    currentActor,
    deck
  })
  return state
}

/** Hides opponents' hole cards and the internal deck before a state is shared with a player. */
export function toPlayerSafeHandState(state: InternalHandState, viewerPlayerId: string): PlayerSafeHandState {
  return Object.freeze({
    handId: state.handId,
    dealerSeat: state.dealerSeat,
    smallBlindSeat: state.smallBlindSeat,
    bigBlindSeat: state.bigBlindSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    board: state.board,
    street: state.street,
    pot: state.pot,
    currentBet: state.currentBet,
    lastFullRaiseSize: state.lastFullRaiseSize,
    actedThisRound: state.actedThisRound,
    bettingRoundComplete: state.bettingRoundComplete,
    currentActor: state.currentActor,
    players: Object.freeze(state.players.map(player => Object.freeze({
      ...player,
      holeCards: player.playerId === viewerPlayerId ? player.holeCards : Object.freeze([])
    })))
  })
}
