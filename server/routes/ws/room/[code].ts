import { getRoomState } from '../../../services/roomService'
import { registerRoomPeer, unregisterRoomPeer } from '../../../ws/roomHub'

function extractRoomCodeFromUrl(url: string): string {
  const parsed = new URL(url, 'http://localhost')
  const parts = parsed.pathname.split('/').filter(Boolean)
  const code = parts[parts.length - 1] ?? ''
  return code.toUpperCase()
}

export default defineWebSocketHandler({
  async upgrade(request) {
    const code = extractRoomCodeFromUrl(request.url)
    if (!code) {
      throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
    }
  },

  async open(peer) {
    const code = extractRoomCodeFromUrl(peer.request.url)
    if (!code) {
      peer.close(1008, 'Некорректный код комнаты')
      return
    }

    registerRoomPeer(code, peer)

    try {
      const state = await getRoomState(code)
      peer.send(
        JSON.stringify({
          type: 'room:joined',
          roomCode: code,
          state,
          timestamp: new Date().toISOString()
        })
      )
    } catch {
      peer.send(
        JSON.stringify({
          type: 'room:error',
          roomCode: code,
          message: 'Не удалось загрузить состояние комнаты',
          timestamp: new Date().toISOString()
        })
      )
    }
  },

  close(peer) {
    const code = extractRoomCodeFromUrl(peer.request.url)
    if (!code) {
      return
    }

    unregisterRoomPeer(code, peer)
  },

  message(peer, message) {
    const code = extractRoomCodeFromUrl(peer.request.url)
    if (!code) {
      return
    }

    const raw = message.text()
    if (raw === 'ping') {
      peer.send(
        JSON.stringify({
          type: 'pong',
          roomCode: code,
          timestamp: new Date().toISOString()
        })
      )
    }
  }
})
