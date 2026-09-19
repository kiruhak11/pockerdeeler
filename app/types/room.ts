export type RoomStatus = 'lobby' | 'active' | 'paused' | 'finished'
export type ParticipantRole = 'dealer' | 'player' | 'spectator'

export interface BuyInSettings {
  enabled: boolean
  minBuyIn: number
  maxBuyIn: number
  allowTopUp: boolean
  topUpOnlyBetweenHands: true
  maxActivePlayerSeatsPerAccount: 1
}

export interface PredictionSettings {
  enabled: boolean
  question: 'main_pot_single_winner'
  grantMode: 'original_buy_in' | 'fixed'
  fixedGrant?: number
  minStake: number
  maxStake: number
  maxStakePercentOfGrant: number
  marketOpenStreet: 'preflop'
  gracePeriodSeconds: number
  virtualLiquidityPerMarket: number
  treasuryInitialBalance: number
  behaviorImpact: number
  includeDecisionTime: boolean
  hidePredictionsFromPlayers: true
  comebackMinBuyIn: number
  comebackMaxBuyIn: number
  maxReentriesPerMember: number
  requireDealerApprovalForReentry: boolean
}

export interface RosterSettings {
  requireDealerApproval: boolean
  lockRosterAfterGameStart: boolean
  allowDealerAccountRebinding: boolean
}

export interface RoomSettings {
  accessMode: 'public' | 'private'
  playerPolicy: 'mixed' | 'accounts' | 'guests'
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  quickBetSteps: number[]
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
  buyIn: BuyInSettings
  predictions: PredictionSettings
  roster: RosterSettings
}

export interface Room {
  id: string
  code: string
  name: string
  status: RoomStatus
  revision: number
  dealerId: string
  hasPassword: boolean
  settings: RoomSettings
  createdAt: string
  updatedAt: string
}

export interface RoomParticipant {
  id: string
  roomId: string
  role: ParticipantRole
  name: string
  sessionTokenHash: string
  isConnected: boolean
  joinedAt: string
  lastSeenAt: string
}

export interface RoomState {
  room: Room
  players: import('./game').Player[]
  currentSession: import('./game').OnlineGameSession | null
  currentHand: import('./game').OnlineHand | null
  actions: import('./game').OnlinePlayerAction[]
  pendingActions: import('./game').OnlinePlayerAction[]
  chatMessages: import('./social').RoomChatMessage[]
  lastDistribution: {
    eventId: string
    handId: string
    handNumber: number
    createdAt: string
    winners: import('./game').WinnerResult[]
    deltas: {
      playerId: string
      delta: number
      finalStack: number
    }[]
  } | null
}

export interface BuyInOptionsView {
  enabled: boolean
  minBuyIn: number
  maxBuyIn: number
  allowTopUp: boolean
  walletBalance: number
  currentStack: number
  maximumTopUp: number
}
