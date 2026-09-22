import type { Peer } from 'crossws'
import { getAuthenticatedOnlineRoom, type ApiOnlineRoomResult } from '../services/onlineRoomApiService'
import { getOnlineRoomRealtimeBus, type OnlineRoomChangedSignal } from '../services/onlineRoomRealtimeService'
import { ONLINE_ROOM_PROTOCOL_VERSION } from './onlineRoomProtocol'

export type OnlineRoomPeerConnection = Readonly<{
  peer: Peer
  roomCode: string
  roomId: string
  userId: string
}>

type MutableConnection = OnlineRoomPeerConnection & {
  lastRoomVersion: number
  lastTableStateVersion: number
}

const peersByRoom = new Map<string, Set<MutableConnection>>()
let subscriptionPromise: Promise<() => void> | undefined

function key(code: string): string {
  return code.trim().toUpperCase()
}

function versionGreater(roomVersion: number, tableStateVersion: number, connection: MutableConnection): boolean {
  return roomVersion > connection.lastRoomVersion ||
    (roomVersion === connection.lastRoomVersion && tableStateVersion > connection.lastTableStateVersion)
}

function send(connection: MutableConnection, payload: unknown): void {
  try {
    connection.peer.send(JSON.stringify(payload))
  } catch {
    // The close hook removes broken local connections.
  }
}

export function sendOnlineRoomError(connection: OnlineRoomPeerConnection, code: string, message: string, roomState?: ApiOnlineRoomResult['room']): void {
  try {
    connection.peer.send(JSON.stringify({ version: ONLINE_ROOM_PROTOCOL_VERSION, type: 'ERROR', code, message, ...(roomState ? { state: roomState } : {}) }))
  } catch {
    // The close hook removes broken local connections.
  }
}

function sendSnapshot(connection: MutableConnection, result: ApiOnlineRoomResult, force = false): void {
  const roomVersion = result.room.roomVersion
  const tableStateVersion = result.room.pokerTable.stateVersion
  if (!force && !versionGreater(roomVersion, tableStateVersion, connection)) return
  connection.lastRoomVersion = roomVersion
  connection.lastTableStateVersion = tableStateVersion
  send(connection, {
    version: ONLINE_ROOM_PROTOCOL_VERSION,
    type: 'ROOM_STATE',
    roomCode: result.room.roomCode,
    roomId: result.room.roomId,
    roomVersion,
    tableStateVersion,
    concurrencyToken: result.concurrencyToken,
    state: result.room
  })
}

async function refreshRoom(signal: OnlineRoomChangedSignal): Promise<void> {
  const peers = peersByRoom.get(key(signal.roomCode))
  if (!peers || peers.size === 0) return
  for (const connection of [...peers]) {
    if (connection.roomId !== signal.roomId || !versionGreater(signal.roomVersion, signal.tableStateVersion, connection)) continue
    try {
      const result = await getAuthenticatedOnlineRoom(connection.userId, connection.roomCode)
      sendSnapshot(connection, result)
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      if (status === 410) {
        connection.peer.close(4004, 'Комната закрыта')
      } else if (status === 403) {
        connection.peer.close(4003, 'Нет доступа к комнате')
      } else {
        sendOnlineRoomError(connection, 'REDIS_UNAVAILABLE', 'Состояние комнаты временно недоступно.')
      }
    }
  }
}

async function ensureSubscription(): Promise<void> {
  if (!subscriptionPromise) {
    subscriptionPromise = getOnlineRoomRealtimeBus().subscribe(refreshRoom).catch(error => {
      subscriptionPromise = undefined
      throw error
    })
  }
  await subscriptionPromise
}

export async function registerOnlineRoomPeer(
  roomCode: string,
  roomId: string,
  userId: string,
  peer: Peer
): Promise<OnlineRoomPeerConnection> {
  const connection: MutableConnection = {
    peer,
    roomCode: key(roomCode),
    roomId,
    userId,
    lastRoomVersion: -1,
    lastTableStateVersion: -1
  }
  const bucket = peersByRoom.get(connection.roomCode) ?? new Set<MutableConnection>()
  bucket.add(connection)
  peersByRoom.set(connection.roomCode, bucket)
  try {
    await ensureSubscription()
  } catch {
    // The authoritative runtime remains available for this instance. A failed
    // Pub/Sub connection only disables cross-instance notifications.
  }
  return connection
}

export function sendInitialOnlineRoomSnapshot(connection: OnlineRoomPeerConnection, result: ApiOnlineRoomResult): void {
  const mutable = findConnection(connection)
  if (mutable) sendSnapshot(mutable, result, true)
}

function findConnection(connection: OnlineRoomPeerConnection): MutableConnection | undefined {
  return [...(peersByRoom.get(key(connection.roomCode)) ?? [])].find(candidate => candidate.peer === connection.peer)
}

export function unregisterOnlineRoomPeer(connection: OnlineRoomPeerConnection): void {
  const roomCode = key(connection.roomCode)
  const bucket = peersByRoom.get(roomCode)
  if (!bucket) return
  for (const candidate of bucket) {
    if (candidate.peer === connection.peer) bucket.delete(candidate)
  }
  if (bucket.size === 0) peersByRoom.delete(roomCode)
}

export function onlineRoomPeerCount(roomCode: string): number {
  return peersByRoom.get(key(roomCode))?.size ?? 0
}

export function sendOnlineRoomAccepted(connection: OnlineRoomPeerConnection, type: 'ACTION_ACCEPTED', result: ApiOnlineRoomResult, extra: Readonly<Record<string, unknown>> = {}): void {
  send(connection as MutableConnection, {
    version: ONLINE_ROOM_PROTOCOL_VERSION,
    type,
    roomCode: result.room.roomCode,
    roomId: result.room.roomId,
    roomVersion: result.room.roomVersion,
    tableStateVersion: result.room.pokerTable.stateVersion,
    concurrencyToken: result.concurrencyToken,
    state: result.room,
    ...extra
  })
}

export function sendOnlineRoomRejected(connection: OnlineRoomPeerConnection, actionId: string, code: string, message: string): void {
  send(connection as MutableConnection, {
    version: ONLINE_ROOM_PROTOCOL_VERSION,
    type: 'ACTION_REJECTED',
    roomCode: connection.roomCode,
    actionId,
    code,
    message
  })
}
