import { getRoomState } from '../../../services/roomService'
import { authorizeRoomRead } from '../../../services/roomAccessService'
import { finishRoomPeerSync, registerRoomPeer, unregisterRoomPeer } from '../../../ws/roomHub'
import type { Peer } from 'crossws'

const authenticated = new WeakSet<Peer>()
const authenticating = new WeakSet<Peer>()
const closed = new WeakSet<Peer>()
const timers = new WeakMap<Peer, ReturnType<typeof setTimeout>>()
function codeOf(url: string) { return new URL(url, 'http://localhost').pathname.split('/').pop()!.toUpperCase() }

export default defineWebSocketHandler({
  open(peer) {
    timers.set(peer, setTimeout(() => { if (!authenticated.has(peer)) peer.close(4003, 'Требуется вход') }, 10_000))
  },
  async message(peer, message) {
    if (message.text() === 'ping' && authenticated.has(peer)) { peer.send(JSON.stringify({ type: 'pong' })); return }
    if (closed.has(peer) || authenticating.has(peer) || authenticated.has(peer) || message.text().length > 2048) return
    authenticating.add(peer)
    try {
      const payload = JSON.parse(message.text()) as { type?: string; token?: string }
      if (payload.type !== 'authenticate' || typeof payload.token !== 'string') { peer.close(4003, 'Требуется вход'); return }
      const code = codeOf(peer.request.url)
      const access = await authorizeRoomRead(code, payload.token)
      if (closed.has(peer)) return
      registerRoomPeer(code, peer, access.participantId, true)
      // Recheck after registration so revocation during the first DB read cannot
      // leave a newly registered, unauthorized socket subscribed indefinitely.
      await authorizeRoomRead(code, payload.token)
      const state = await getRoomState(code)
      if (closed.has(peer)) return
      authenticated.add(peer)
      clearTimeout(timers.get(peer))
      finishRoomPeerSync(code, peer, state)
    } catch (error) {
      unregisterRoomPeer(codeOf(peer.request.url), peer)
      const status = (error as { statusCode?: number }).statusCode
      peer.close(status === 404 ? 4004 : status === 401 || status === 403 ? 4003 : 1011, 'Не удалось подключиться к комнате')
    } finally { authenticating.delete(peer) }
  },
  close(peer) {
    clearTimeout(timers.get(peer))
    authenticated.delete(peer)
    closed.add(peer)
    unregisterRoomPeer(codeOf(peer.request.url), peer)
  }
})
