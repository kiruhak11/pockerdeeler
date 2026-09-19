import type { Peer } from 'crossws'
import type { RoomState } from '../services/roomService'

const peersByRoom = new Map<string, Set<Peer>>()
const participants = new WeakMap<Peer, string | null>()
const syncing = new WeakMap<Peer, RoomState | null>()
const revisions = new WeakMap<Peer, number>()

function roomKey(code: string): string {
  return code.trim().toUpperCase()
}

export function registerRoomPeer(code: string, peer: Peer, participantId: string | null = null, awaitingSnapshot = false) {
  participants.set(peer, participantId)
  revisions.delete(peer)
  if (awaitingSnapshot) syncing.set(peer, null)
  const key = roomKey(code)
  const bucket = peersByRoom.get(key) ?? new Set<Peer>()
  bucket.add(peer)
  peersByRoom.set(key, bucket)
}

export function finishRoomPeerSync(code: string, peer: Peer, snapshot: RoomState) {
  if (!peersByRoom.get(roomKey(code))?.has(peer) || !syncing.has(peer)) return
  const buffered = syncing.get(peer)
  const state = buffered && buffered.room.revision > snapshot.room.revision ? buffered : snapshot
  syncing.delete(peer)
  revisions.set(peer, state.room.revision)
  peer.send(JSON.stringify({ type: 'room:joined', roomCode: roomKey(code), state, timestamp: new Date().toISOString() }))
}

export function revokeRoomParticipant(code: string, participantId: string, closeCode = 4003) {
  for (const peer of peersByRoom.get(roomKey(code)) || []) {
    if (participants.get(peer) === participantId) {
      unregisterRoomPeer(code, peer)
      peer.close(closeCode, closeCode === 4005 ? 'Место сохранено в аккаунте' : 'Сессия участника завершена')
    }
  }
}

export function closeRoomPeers(code: string) {
  for (const peer of peersByRoom.get(roomKey(code)) || []) peer.close(4004, 'Комната удалена')
  peersByRoom.delete(roomKey(code))
}

export function unregisterRoomPeer(code: string, peer: Peer) {
  syncing.delete(peer)
  revisions.delete(peer)
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
      if (payload.state) {
        if (syncing.has(peer)) {
          const buffered = syncing.get(peer)
          if (!buffered || payload.state.room.revision > buffered.room.revision) syncing.set(peer, payload.state)
          continue
        }
        if (payload.state.room.revision < (revisions.get(peer) ?? -1)) continue
        revisions.set(peer, payload.state.room.revision)
      }
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
