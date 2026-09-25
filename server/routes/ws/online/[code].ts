import type { Message, Peer } from 'crossws'
import { verifyUserAuthToken } from '../../../services/userAccountService'
import {
  applyAuthenticatedOnlineRoomAction,
  cleanupDisconnectedOnlineRoomParticipant,
  getAuthenticatedOnlineRoom,
  OnlineRoomApiError,
  setAuthenticatedOnlineRoomPresence,
  startAuthenticatedOnlineRoomHand
} from '../../../services/onlineRoomApiService'
import { getOnlineRoomPresenceService, type OnlineRoomPresenceRegistration, type OnlineRoomPresenceService, type OnlineRoomSpectatorRegistration } from '../../../services/onlineRoomPresenceService'
import { normalizeGlobalRoomCode } from '../../../services/roomCodeRegistryService'
import {
  registerOnlineRoomPeer,
  sendInitialOnlineRoomSnapshot,
  sendOnlineRoomAccepted,
  sendOnlineRoomError,
  sendOnlineRoomRejected,
  unregisterOnlineRoomPeer,
  type OnlineRoomPeerConnection
} from '../../../ws/onlineRoomHub'
import { parseOnlineRoomClientMessage } from '../../../ws/onlineRoomProtocol'
import { ONLINE_ROOM_PROTOCOL_VERSION } from '../../../ws/onlineRoomProtocol'

const ACCOUNT_COOKIE = 'poker_account'

type AuthenticatedSocket = {
  userId: string
  connection: OnlineRoomPeerConnection
  presence?: OnlineRoomPresenceService
  presenceRegistration?: OnlineRoomPresenceRegistration
  spectatorRegistration?: OnlineRoomSpectatorRegistration
}

const sockets = new WeakMap<Peer, AuthenticatedSocket>()
const authenticating = new WeakSet<Peer>()
const closed = new WeakSet<Peer>()
const timers = new WeakMap<Peer, ReturnType<typeof setTimeout>>()

function requestUrl(peer: Peer): URL {
  return new URL(peer.request.url, 'http://localhost')
}

function roomCode(peer: Peer): string {
  const value = requestUrl(peer).pathname.split('/').filter(Boolean).pop() ?? ''
  return normalizeGlobalRoomCode(decodeURIComponent(value))
}

function cookieValue(headers: Headers, name: string): string {
  const raw = headers.get('cookie') ?? ''
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim())
  }
  return ''
}

function originAllowed(peer: Peer): boolean {
  const origin = peer.request.headers.get('origin')
  if (!origin) return false
  const request = requestUrl(peer)
  const requestOrigin = `${request.protocol === 'ws:' ? 'http:' : request.protocol === 'wss:' ? 'https:' : request.protocol}//${request.host}`
  const configuredUrl = process.env.NUXT_PUBLIC_APP_URL
  if (configuredUrl) return origin === new URL(configuredUrl).origin
  return origin === requestOrigin
}

function closeUnauthorized(peer: Peer, reason = 'Не удалось авторизовать WebSocket'): void {
  peer.close(4003, reason)
}

function errorCode(error: unknown): string {
  if (error instanceof OnlineRoomApiError) {
    if (error.code === 'STALE_STATE') return 'STALE_STATE'
    if (error.code === 'NOT_YOUR_TURN') return 'NOT_YOUR_TURN'
    if (error.code === 'HAND_NOT_ACTIVE') return 'HAND_NOT_ACTIVE'
    if (error.code === 'ACTION_CONFLICT') return 'ACTION_CONFLICT'
    if (error.code === 'INVALID_ACTION') return 'INVALID_ACTION'
    if (error.code === 'NOT_FOUND') return 'NOT_MEMBER'
    if (error.code === 'CLOSED') return 'ROOM_NOT_FOUND'
    if (error.code === 'CONFLICT') return 'STALE_STATE'
    if (error.code === 'UNAVAILABLE') return 'REDIS_UNAVAILABLE'
    return error.code
  }
  return 'SERVICE_UNAVAILABLE'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Online room service is temporarily unavailable.'
}

async function sendFreshState(peer: Peer, socket: AuthenticatedSocket): Promise<void> {
  try {
    const result = await getAuthenticatedOnlineRoom(socket.userId, socket.connection.roomCode)
    sendInitialOnlineRoomSnapshot(socket.connection, result)
  } catch (error) {
    sendOnlineRoomError(socket.connection, errorCode(error), errorMessage(error))
  }
}

function monitorPresenceLease(presence: OnlineRoomPresenceService, registration: OnlineRoomPresenceRegistration, roomCode: string): void {
  presence.scheduleConnectionExpiry(registration, async () => {
    presence.scheduleGraceExpiry(registration.roomId, registration.userId, async () => {
      await cleanupDisconnectedOnlineRoomParticipant(registration.userId, roomCode)
    })
  })
}

async function authenticate(peer: Peer): Promise<AuthenticatedSocket> {
  if (!originAllowed(peer)) {
    throw new OnlineRoomApiError('FORBIDDEN', 'Недопустимый Origin', 403)
  }
  const auth = await verifyUserAuthToken(cookieValue(peer.request.headers, ACCOUNT_COOKIE))
  if (!auth) {
    throw new OnlineRoomApiError('UNAUTHORIZED', 'Требуется вход', 401)
  }
  let code: string
  try {
    code = roomCode(peer)
  } catch {
    throw new OnlineRoomApiError('NOT_FOUND', 'Комната не найдена', 404)
  }
  const result = await getAuthenticatedOnlineRoom(auth.userId, code)
  const seated = result.room.pokerTable.players.some(player => player.playerId === auth.userId)
  const spectator = !seated && result.room.visibility === 'PUBLIC'
  const presence = seated || spectator ? getOnlineRoomPresenceService() : undefined
  const registered = presence && seated ? await presence.registerConnection(result.room.roomId, auth.userId) : undefined
  const spectatorRegistration = presence && spectator
    ? await presence.registerSpectatorConnection(result.room.roomId, auth.userId).catch(() => undefined)
    : undefined
  try {
    if (presence && registered) await setAuthenticatedOnlineRoomPresence(auth.userId, code, true)
    const fresh = await getAuthenticatedOnlineRoom(auth.userId, code)
    const connection = await registerOnlineRoomPeer(code, fresh.room.roomId, auth.userId, peer)
    const socket = {
      userId: auth.userId,
      connection,
      ...(presence && registered ? { presence, presenceRegistration: registered.registration } : {}),
      ...(presence && spectatorRegistration ? { presence, spectatorRegistration } : {})
    } satisfies AuthenticatedSocket
    if (closed.has(peer)) {
      unregisterOnlineRoomPeer(connection)
      if (presence && registered) {
        const released = await presence.unregisterConnection(registered.registration)
        if (released.graceStarted) {
          presence.scheduleGraceExpiry(connection.roomId, auth.userId, async () => {
            await cleanupDisconnectedOnlineRoomParticipant(auth.userId, code)
          })
        }
      }
      if (presence && spectatorRegistration) await presence.unregisterSpectatorConnection(spectatorRegistration).catch(() => undefined)
      throw new Error('WebSocket closed during authentication.')
    }
    sockets.set(peer, socket)
    if (presence && registered) monitorPresenceLease(presence, registered.registration, code)
    sendInitialOnlineRoomSnapshot(connection, fresh)
    return socket
  } catch (error) {
    if (presence && registered) {
      const released = await presence.unregisterConnection(registered.registration).catch(() => undefined)
      if (released?.graceStarted) {
        presence.scheduleGraceExpiry(result.room.roomId, auth.userId, async () => {
          await cleanupDisconnectedOnlineRoomParticipant(auth.userId, code)
        })
      }
    }
    if (presence && spectatorRegistration) await presence.unregisterSpectatorConnection(spectatorRegistration).catch(() => undefined)
    throw error
  }
}

async function handleMessage(peer: Peer, message: Message, socket: AuthenticatedSocket): Promise<void> {
  let raw: string
  try {
    raw = message.text()
  } catch {
    sendOnlineRoomError(socket.connection, 'INVALID_MESSAGE', 'Сообщение должно быть текстовым JSON.')
    return
  }
  if (raw.length > 16 * 1024) {
    sendOnlineRoomError(socket.connection, 'MESSAGE_TOO_LARGE', 'Сообщение слишком большое.')
    return
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    sendOnlineRoomError(socket.connection, 'INVALID_MESSAGE', 'Некорректный JSON.')
    return
  }
  const parsed = parseOnlineRoomClientMessage(raw)
  if (!parsed) {
    const command = typeof value === 'object' && value !== null && 'type' in value ? (value as { type?: unknown }).type : undefined
    sendOnlineRoomError(socket.connection, typeof command === 'string' ? 'UNKNOWN_COMMAND' : 'INVALID_MESSAGE', 'Неизвестная или некорректная команда.')
    return
  }
  if (parsed.type === 'PING') {
    try {
      if (socket.presence && socket.spectatorRegistration) {
        const fresh = await getAuthenticatedOnlineRoom(socket.userId, socket.connection.roomCode)
        const seated = fresh.room.pokerTable.players.some(player => player.playerId === socket.userId)
        if (seated) {
          await socket.presence.unregisterSpectatorConnection(socket.spectatorRegistration)
          socket.spectatorRegistration = undefined
          const registered = await socket.presence.registerConnection(fresh.room.roomId, socket.userId)
          await setAuthenticatedOnlineRoomPresence(socket.userId, socket.connection.roomCode, true)
          socket.presenceRegistration = registered.registration
          monitorPresenceLease(socket.presence, registered.registration, socket.connection.roomCode)
        } else {
          await socket.presence.refreshSpectatorConnection(socket.spectatorRegistration)
        }
      } else if (socket.presence && socket.presenceRegistration) {
        await socket.presence.refreshConnection(socket.presenceRegistration)
      }
      peer.send(JSON.stringify({ version: ONLINE_ROOM_PROTOCOL_VERSION, type: 'PONG' }))
    } catch (error) {
      sendOnlineRoomError(socket.connection, errorCode(error), errorMessage(error))
      peer.close(1011, 'Состояние присутствия временно недоступно')
    }
    return
  }
  if (parsed.type === 'REQUEST_STATE') {
    await sendFreshState(peer, socket)
    return
  }
  if (parsed.type === 'START_HAND') {
    try {
      const result = await startAuthenticatedOnlineRoomHand(socket.userId, socket.connection.roomCode, parsed.expectedTableStateVersion)
      sendOnlineRoomAccepted(socket.connection, 'ACTION_ACCEPTED', result, { command: 'START_HAND' })
    } catch (error) {
      sendOnlineRoomError(socket.connection, errorCode(error), errorMessage(error))
      if (errorCode(error) === 'STALE_STATE') await sendFreshState(peer, socket)
    }
    return
  }
  try {
    const result = await applyAuthenticatedOnlineRoomAction(socket.userId, socket.connection.roomCode, {
      actionId: parsed.actionId,
      expectedTableStateVersion: parsed.expectedTableStateVersion,
      action: parsed.action
    })
    sendOnlineRoomAccepted(socket.connection, 'ACTION_ACCEPTED', result, { actionId: parsed.actionId, duplicate: result.duplicate })
  } catch (error) {
    const code = errorCode(error)
    sendOnlineRoomRejected(socket.connection, parsed.actionId, code, errorMessage(error))
    if (code === 'STALE_STATE') await sendFreshState(peer, socket)
  }
}

export default defineWebSocketHandler({
  async open(peer) {
    authenticating.add(peer)
    timers.set(peer, setTimeout(() => {
      if (!sockets.has(peer)) closeUnauthorized(peer, 'Требуется вход')
    }, 10_000))
    try {
      await authenticate(peer)
    } catch (error) {
      // Authentication and room authorization failures are always controlled
      // socket closes; a malformed/private/unknown room must not linger.
      if (!closed.has(peer)) {
        const status = error instanceof OnlineRoomApiError ? error.statusCode : undefined
        if (status === 404 || status === 410) peer.close(4004, 'Комната не найдена')
        else if (status === 401 || status === 403) peer.close(4003, 'Нет доступа к комнате')
        else peer.close(1011, 'Состояние комнаты временно недоступно')
      }
    } finally {
      authenticating.delete(peer)
    }
  },
  async message(peer, message) {
    if (closed.has(peer)) return
    const socket = sockets.get(peer)
    if (!socket) {
      if (authenticating.has(peer)) return
      closeUnauthorized(peer, 'Требуется вход')
      return
    }
    await handleMessage(peer, message, socket)
  },
  close(peer) {
    clearTimeout(timers.get(peer))
    closed.add(peer)
    const socket = sockets.get(peer)
    if (socket) {
      unregisterOnlineRoomPeer(socket.connection)
      if (socket.presence && socket.presenceRegistration) {
        void socket.presence.unregisterConnection(socket.presenceRegistration).then(result => {
          if (!result.graceStarted) return
          socket.presence!.scheduleGraceExpiry(socket.connection.roomId, socket.userId, async () => {
            await cleanupDisconnectedOnlineRoomParticipant(socket.userId, socket.connection.roomCode)
          })
        }).catch(() => undefined)
      }
      if (socket.presence && socket.spectatorRegistration) {
        void socket.presence.unregisterSpectatorConnection(socket.spectatorRegistration).catch(() => undefined)
      }
    }
    authenticating.delete(peer)
    sockets.delete(peer)
  }
})
