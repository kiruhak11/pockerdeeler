export type RoomStatus = 'lobby' | 'active' | 'paused' | 'finished'
export type ParticipantRole = 'dealer' | 'player' | 'spectator'

export interface RoomSettings {
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  quickBetSteps: number[]
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
}

export interface Room {
  id: string
  code: string
  name: string
  status: RoomStatus
  dealerId: string
  dealerSecretHash: string
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
