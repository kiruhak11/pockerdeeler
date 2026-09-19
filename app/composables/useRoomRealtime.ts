import { reconnectDelay, type RealtimeEnvelope } from '~/types/realtime'
import { useRoomStore } from '~/stores/room'

export function useRoomRealtime(roomCode: MaybeRefOrGetter<string | undefined>) {
  const roomStore = useRoomStore()
  const credentials = useRoomCredentials()
  const ws = shallowRef<WebSocket | null>(null)
  const code = computed(() => toValue(roomCode)?.trim().toUpperCase())
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined
  let mounted = false
  let enabled = true
  let terminal = false
  let attempt = 0
  let lastReply = 0
  let openedAt = 0
  let joined = false

  function clearSocket() {
    clearTimeout(reconnectTimer)
    clearInterval(watchdog)
    reconnectTimer = undefined
    watchdog = undefined
    const socket = ws.value
    ws.value = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
    }
  }

  function scheduleReconnect() {
    if (!mounted || !enabled || terminal) return
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, reconnectDelay(attempt++))
  }

  function lostConnection() {
    clearSocket()
    roomStore.setConnectionStatus('disconnected')
    scheduleReconnect()
  }

  function connect() {
    if (!mounted || !enabled || terminal || !code.value || ws.value) return
    clearTimeout(reconnectTimer)
    const currentCode = code.value
    const token = credentials.token(currentCode)
    if (!token) {
      terminal = true
      roomStore.setConnectionStatus('unauthorized')
      return
    }
    roomStore.setConnectionStatus('connecting')
    joined = false
    openedAt = lastReply = Date.now()
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try { socket = new WebSocket(`${protocol}//${window.location.host}/ws/room/${currentCode}`) }
    catch { lostConnection(); return }
    ws.value = socket
    socket.onopen = () => {
      if (ws.value !== socket) return
      roomStore.setConnectionStatus('syncing')
      socket.send(JSON.stringify({ type: 'authenticate', token }))
    }
    socket.onmessage = event => {
      if (ws.value !== socket) return
      try {
        const payload = JSON.parse(event.data) as RealtimeEnvelope
        if (payload.type === 'pong') { lastReply = Date.now(); return }
        if (payload.roomCode !== currentCode) return
        if (payload.type === 'room:error') {
          roomStore.setError(payload.message || 'Не удалось обновить игру')
          lostConnection()
          return
        }
        if (!payload.state || !['room:joined', 'room_state_updated'].includes(payload.type)) return
        // Every update is a complete snapshot; revision jumps are not missing deltas.
        const accepted = roomStore.setRoomState(payload.state)
        if (payload.type === 'room:joined') {
          // A newer HTTP response may have won the race. Request another handshake,
          // rather than marking an older initial snapshot as fresh.
          if (!accepted) { lostConnection(); return }
          joined = true
        }
        if (accepted && joined) {
          lastReply = Date.now()
          attempt = 0
          roomStore.setConnectionStatus('connected')
        }
      } catch { /* Ignore malformed messages; the watchdog still expires. */ }
    }
    socket.onclose = event => {
      if (ws.value !== socket) return
      clearSocket()
      if ([4001, 4003, 4004, 4005].includes(event.code)) {
        terminal = true
        roomStore.setConnectionStatus('unauthorized')
        roomStore.setError(event.code === 4004 ? 'Комната закрыта' : event.code === 4005
          ? 'Место сохранено. Вернитесь через список столов.' : 'Нет доступа к комнате. Войдите повторно или восстановите место через аккаунт.')
        return
      }
      roomStore.setConnectionStatus('disconnected')
      scheduleReconnect()
    }
    socket.onerror = () => { if (ws.value === socket) lostConnection() }
    watchdog = setInterval(() => {
      if (ws.value !== socket) return
      const now = Date.now()
      if ((!joined && now - openedAt > 15_000) || now - lastReply > 35_000) { lostConnection(); return }
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send('ping') } catch { lostConnection() }
      }
    }, 10_000)
  }

  function disconnect() {
    enabled = false
    clearSocket()
    roomStore.setConnectionStatus('disconnected')
  }

  function reconnect() {
    if (!mounted) return
    clearSocket()
    enabled = true
    terminal = false
    attempt = 0
    connect()
  }

  function foreground() {
    if (!enabled || terminal || document.visibilityState === 'hidden') return
    // Timers and half-open TCP connections cannot be trusted after iOS suspension.
    reconnect()
  }
  function visibilityChanged() {
    if (document.visibilityState === 'hidden') {
      if (enabled && !terminal) { clearSocket(); roomStore.setConnectionStatus('disconnected') }
    } else foreground()
  }
  function offline() { if (enabled) { clearSocket(); roomStore.setConnectionStatus('disconnected') } }
  function pagehide() { if (enabled) { clearSocket(); roomStore.setConnectionStatus('disconnected') } }

  watch(code, () => { if (mounted) reconnect() })
  watch(() => roomStore.retryConnectionRequest, reconnect)
  onMounted(() => {
    mounted = true
    window.addEventListener('online', foreground)
    window.addEventListener('offline', offline)
    window.addEventListener('pageshow', foreground)
    window.addEventListener('pagehide', pagehide)
    document.addEventListener('visibilitychange', visibilityChanged)
    connect()
  })
  onBeforeUnmount(() => {
    mounted = false
    disconnect()
    window.removeEventListener('online', foreground)
    window.removeEventListener('offline', offline)
    window.removeEventListener('pageshow', foreground)
    window.removeEventListener('pagehide', pagehide)
    document.removeEventListener('visibilitychange', visibilityChanged)
  })

  return { connect, disconnect, reconnect, socket: ws }
}
