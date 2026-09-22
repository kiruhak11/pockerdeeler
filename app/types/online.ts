export const ONLINE_PROTOCOL_VERSION = 1 as const

export type OnlineCard = Readonly<{
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A'
}>

export type OnlineHandPlayerStatus = 'ACTIVE' | 'ALL_IN' | 'FOLDED' | 'OUT'
export type OnlinePlayerAction = 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all-in'
export type OnlineHandStreet = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'FINISHED'

export type OnlineTablePlayer = Readonly<{
  playerId: string
  seat: number
  stack: number
  connected: boolean
  ready: boolean
  sittingOut: boolean
  nickname?: string
}>

export type OnlineHandPlayer = Readonly<{
  playerId: string
  seat: number
  stack: number
  contribution: number
  streetContribution: number
  status: OnlineHandPlayerStatus
  holeCards: readonly OnlineCard[]
  nickname?: string
  lastAction?: OnlinePlayerAction | null
}>

export type OnlineHandStrength = Readonly<{
  category: 'high-card' | 'one-pair' | 'two-pair' | 'three-of-a-kind' | 'straight' | 'flush' | 'full-house' | 'four-of-a-kind' | 'straight-flush'
  categoryRank: number
  label: string
  contributingCardIds: readonly string[]
}>

export type OnlineHand = Readonly<{
  handId: string
  dealerSeat: number
  smallBlindSeat: number
  bigBlindSeat: number
  smallBlind: number
  bigBlind: number
  board: readonly OnlineCard[]
  street: OnlineHandStreet
  pot: number
  currentBet: number
  bettingRoundComplete: boolean
  currentActor: number | null
  turnDeadlineAt: number | null
  handStrength?: OnlineHandStrength
  players: readonly OnlineHandPlayer[]
}>

export type OnlinePokerTable = Readonly<{
  tableId: string
  maxPlayers: 6
  status: 'WAITING' | 'IN_HAND'
  dealerSeat: number | null
  stateVersion: number
  handSequence: number
  smallBlind: number
  bigBlind: number
  seats: readonly Readonly<{ seat: number; playerId: string | null }>[]
  players: readonly OnlineTablePlayer[]
  currentHand: OnlineHand | null
}>

export type OnlineRoomState = Readonly<{
  roomId: string
  roomCode: string
  type: 'ONLINE'
  visibility: 'PUBLIC' | 'PRIVATE'
  ownerId: string | null
  status: 'WAITING' | 'IN_HAND' | 'CLOSED'
  createdAt: string
  maxPlayers: 6
  roomVersion: number
  pokerTable: OnlinePokerTable
}>

export type OnlineApiResult = Readonly<{
  room: OnlineRoomState
  concurrencyToken: string
}>

export type OnlineActionType = 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all-in'
export type OnlineAction = Readonly<{
  type: OnlineActionType
  amount?: number
}>

export type OnlineConnectionStatus = 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'unauthorized' | 'not-found' | 'unavailable' | 'error'
