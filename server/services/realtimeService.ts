import { broadcastRoomState, broadcastToRoom } from '../ws/roomHub'
import type { RoomState } from './roomService'

export const realtimeService = {
  broadcastRoomState,
  broadcastEvent(roomCode: string, type: string, message?: string, state?: RoomState) {
    broadcastToRoom(roomCode, {
      type,
      roomCode,
      message,
      state,
      timestamp: new Date().toISOString()
    })
  }
}
