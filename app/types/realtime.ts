import type { RoomState } from './room'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'unauthorized'

export interface UncertainPlayerAction {
  roomCode: string
  playerId: string
  clientRequestId: string
  handId: string
  expectedRevision: number
  type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'
  amount: number
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
  return Math.round(cap * (0.5 + random() * 0.5))
}

export type RealtimeEventType =
  | 'pong'
  | 'room:joined'
  | 'room:updated'
  | 'player:joined'
  | 'player:left'
  | 'player:connected'
  | 'player:disconnected'
  | 'game:started'
  | 'hand:started'
  | 'action:requested'
  | 'action:pending'
  | 'action:approved'
  | 'action:rejected'
  | 'action:applied'
  | 'hand:finished'
  | 'pot:distributed'
  | 'room:error'
  | 'room_state_updated'

export interface RealtimeEnvelope {
  type: RealtimeEventType
  roomCode: string
  state?: RoomState
  message?: string
  timestamp: string
}
