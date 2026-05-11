import type { RoomState } from './room'

export type RealtimeEventType =
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
