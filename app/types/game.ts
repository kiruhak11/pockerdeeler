export type PlayerStatus = 'waiting' | 'active' | 'checked' | 'folded' | 'all-in' | 'winner' | 'out'

export type PlayerActionType = 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'

export type HandStage = 'setup' | 'playing' | 'showdown' | 'completed'
export type GameVariant = 'texas-holdem' | 'omaha'

export interface Player {
  id: string
  name: string
  stack: number
  currentBet: number
  totalCommitted: number
  status: PlayerStatus
  seat?: number
}

export interface WinnerResult {
  playerId: string
  amountWon: number
}

export interface PlayerAction {
  id: string
  playerId: string
  type: PlayerActionType
  amount: number
  timestamp: number
}

export interface HandHistory {
  handNumber: number
  actions: PlayerAction[]
  pot: number
  winners: WinnerResult[]
  playerSnapshotsBefore: Player[]
  playerSnapshotsAfter: Player[]
}

export interface Game {
  id: string
  variant: GameVariant
  smallBlind: number
  bigBlind: number
  quickRaiseSteps: number[]
  players: Player[]
  pot: number
  currentBet: number
  handNumber: number
  handActive: boolean
  handStage: HandStage
  history: HandHistory[]
  actions: PlayerAction[]
  pendingWinners: string[]
  handStartedAt: number
  tableChipsTotal: number
}

export interface GameSnapshot {
  players: Player[]
  pot: number
  currentBet: number
  actions: PlayerAction[]
  handActive: boolean
  handStage: HandStage
  pendingWinners: string[]
}

export interface SidePot {
  id: number
  amount: number
  cap: number
  eligiblePlayerIds: string[]
}

export interface PotDistributionResult {
  winners: WinnerResult[]
  returned: WinnerResult[]
  pots: SidePot[]
}

export interface ActionInput {
  playerId: string
  type: PlayerActionType
  amount?: number
}

export interface ActionResult {
  players: Player[]
  pot: number
  currentBet: number
  action: PlayerAction
}

export interface ToastMessage {
  id: string
  type: 'error' | 'success' | 'info'
  text: string
}

export type OnlineGameSessionStatus = 'lobby' | 'playing' | 'hand_finished' | 'finished'
export type OnlineHandStatus = 'active' | 'showdown' | 'finished'
export type OnlineActionStatus = 'pending' | 'approved' | 'rejected' | 'applied'

export interface OnlineGameSession {
  id: string
  roomId: string
  status: OnlineGameSessionStatus
  handNumber: number
  pot: number
  currentBet: number
  currentPlayerId?: string
  dealerButtonPlayerId?: string
  smallBlindPlayerId?: string
  bigBlindPlayerId?: string
  createdAt: string
  updatedAt: string
}

export interface OnlineHand {
  id: string
  roomId: string
  sessionId: string
  handNumber: number
  status: OnlineHandStatus
  pot: number
  currentBet: number
  startedAt: string
  finishedAt?: string
}

export interface OnlinePlayerAction {
  id: string
  roomId: string
  handId: string
  playerId: string
  type: PlayerActionType
  amount: number
  status: OnlineActionStatus
  clientRequestId: string
  createdAt: string
  appliedAt?: string
}

export interface AvailableActions {
  canCheck: boolean
  canCall: boolean
  canBet: boolean
  canRaise: boolean
  canFold: boolean
  canAllIn: boolean
  callAmount: number
  minRaiseAmount: number
  disabledReason?: string
}
