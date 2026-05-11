import type { Peer } from 'crossws'
import type { RoomState } from '../services/roomService'

const peersByRoom = new Map<string, Set<Peer>>()

function roomKey(code: string): string {
  return code.trim().toUpperCase()
}

export function registerRoomPeer(code: string, peer: Peer) {
  const key = roomKey(code)
  const bucket = peersByRoom.get(key) ?? new Set<Peer>()
  bucket.add(peer)
  peersByRoom.set(key, bucket)
}

export function unregisterRoomPeer(code: string, peer: Peer) {
  const key = roomKey(code)
  const bucket = peersByRoom.get(key)
  if (!bucket) {
    return
  }

  bucket.delete(peer)

  if (bucket.size === 0) {
    peersByRoom.delete(key)
  }
}

export function broadcastToRoom(
  code: string,
  payload: {
    type: string
    roomCode: string
    state?: RoomState
    message?: string
    timestamp: string
  }
) {
  const key = roomKey(code)
  const bucket = peersByRoom.get(key)
  if (!bucket || bucket.size === 0) {
    return
  }

  const message = JSON.stringify(payload)
  for (const peer of bucket) {
    try {
      peer.send(message)
    } catch {
      // Ignore broken peers; close lifecycle will clean them.
    }
  }
}

export function broadcastRoomState(roomCode: string, state: RoomState) {
  broadcastToRoom(roomCode, {
    type: 'room_state_updated',
    roomCode,
    state,
    timestamp: new Date().toISOString()
  })
}
