import type { PlayerActionType } from './game'
import type { Room, RoomSettings, RoomState } from './room'

export interface CreateRoomInput extends RoomSettings {
  name: string
}

export interface CreateRoomResponse {
  roomCode: string
  dealerUrl: string
  joinUrl: string
  dealerSecret: string
}

export interface JoinRoomInput {
  name: string
  role?: 'player' | 'spectator'
}

export interface JoinRoomResponse {
  roomCode: string
  playerId?: string
  participantId: string
  playerSessionToken: string
  playerUrl: string
}

export interface RoomStateResponse {
  room: Room
  players: import('./game').Player[]
  currentSession: import('./game').OnlineGameSession | null
  currentHand: import('./game').OnlineHand | null
  actions: import('./game').OnlinePlayerAction[]
  pendingActions: import('./game').OnlinePlayerAction[]
  lastDistribution: import('./room').RoomState['lastDistribution']
}

export interface PlayerActionInput {
  playerId: string
  token: string
  type: PlayerActionType
  amount: number
  clientRequestId: string
}

export interface PlayerActionResponse {
  success: boolean
  action?: import('./game').OnlinePlayerAction
  state?: RoomState
  error?: string
}
