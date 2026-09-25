import { actionMessage, createOnlineActionId, onlineSocketUrl, pingMessage, startHandMessage } from '~/utils/onlineRoomUi'
import type { OnlineAction, OnlineConnectionStatus, OnlineRoomState } from '~/types/online'
import { platformFromPath } from '~/platform/types'
import { yandexAuthHeaders } from '~/platform/yandexSession'

type SocketHandlers = Readonly<{
  onState?: (state: OnlineRoomState, concurrencyToken?: string) => void
  onNotice?: (message: string) => void
}>

export function useOnlineRoomSocket(roomCode: MaybeRefOrGetter<string>, handlers: SocketHandlers = {}) {
  const route = useRoute()
  const isYandex = computed(() => platformFromPath(route.path, route.query.platform) === 'YANDEX_GAMES')
  const status = ref<OnlineConnectionStatus>('loading')
  const errorMessage = ref('')
  const pendingActionId = ref<string | null>(null)
  const socket = shallowRef<WebSocket | null>(null)
  let mounted = false
  let enabled = true
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let attempt = 0
  let stateVersion = 0

  const code = computed(() => toValue(roomCode).trim().toUpperCase())

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (heartbeat) clearInterval(heartbeat)
    reconnectTimer = undefined
    heartbeat = undefined
  }

  function closeSocket() {
    clearTimers()
    const current = socket.value
    socket.value = null
    if (current) {
      current.onopen = current.onmessage = current.onerror = current.onclose = null
      current.close()
    }
  }

  function scheduleReconnect() {
    if (!mounted || !enabled || reconnectTimer) return
    status.value = 'reconnecting'
    const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 4)))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  function protocolError(code: string, message: string) {
    const friendly = code === 'STALE_STATE' ? 'Состояние стола изменилось. Обновляем…'
      : code === 'NOT_YOUR_TURN' ? 'Сейчас ход другого игрока.'
        : code === 'REDIS_UNAVAILABLE' ? 'Сервис стола временно недоступен.'
          : message || 'Действие не принято.'
    errorMessage.value = friendly
    if (code === 'REDIS_UNAVAILABLE') status.value = 'unavailable'
    handlers.onNotice?.(friendly)
  }

  function handlePayload(payload: any) {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === 'ROOM_STATE' || payload.type === 'ACTION_ACCEPTED') {
      if (payload.state && typeof payload.state === 'object') {
        stateVersion = Number(payload.state.pokerTable?.stateVersion ?? payload.tableStateVersion ?? stateVersion)
        handlers.onState?.(payload.state as OnlineRoomState, typeof payload.concurrencyToken === 'string' ? payload.concurrencyToken : undefined)
      }
      if (payload.type === 'ACTION_ACCEPTED') pendingActionId.value = null
      status.value = 'connected'
      attempt = 0
      return
    }
    if (payload.type === 'ACTION_REJECTED') {
      if (!pendingActionId.value || pendingActionId.value === payload.actionId) pendingActionId.value = null
      protocolError(String(payload.code || ''), String(payload.message || ''))
      if (payload.code === 'STALE_STATE') requestState()
      return
    }
    if (payload.type === 'ERROR') {
      protocolError(String(payload.code || ''), String(payload.message || ''))
      if (payload.state) {
        stateVersion = Number(payload.state.pokerTable?.stateVersion ?? stateVersion)
        handlers.onState?.(payload.state as OnlineRoomState, typeof payload.concurrencyToken === 'string' ? payload.concurrencyToken : undefined)
      }
      return
    }
    if (payload.type === 'PONG') return
  }

  async function connect() {
    if (!mounted || !enabled || socket.value || !code.value || typeof window === 'undefined') return
    status.value = attempt > 0 ? 'reconnecting' : 'connecting'
    errorMessage.value = ''
    let current: WebSocket
    try {
      let ticket: string | undefined
      if (isYandex.value) {
        const result = await $fetch<{ ticket: string }>('/api/auth/yandex/ws-ticket', { method: 'POST', headers: yandexAuthHeaders(isYandex.value), retry: 0 })
        ticket = result.ticket
      }
      if (!mounted || !enabled || socket.value) return
      current = new WebSocket(onlineSocketUrl(window.location, code.value, ticket))
    } catch {
      scheduleReconnect()
      return
    }
    socket.value = current
    current.onopen = () => {
      if (socket.value !== current) return
      status.value = 'connecting'
      current.send(JSON.stringify({ version: 1, type: 'REQUEST_STATE' }))
      heartbeat = setInterval(() => {
        if (current.readyState !== WebSocket.OPEN) return
        try { current.send(JSON.stringify(pingMessage())) } catch { closeSocket(); scheduleReconnect() }
      }, 15_000)
    }
    current.onmessage = event => {
      if (socket.value !== current) return
      try { handlePayload(JSON.parse(String(event.data))) } catch { /* malformed server data is ignored */ }
    }
    current.onerror = () => {
      if (socket.value === current) closeSocket()
      scheduleReconnect()
    }
    current.onclose = event => {
      if (socket.value !== current) return
      closeSocket()
      if (event.code === 4003) { status.value = 'unauthorized'; errorMessage.value = 'Войдите, чтобы открыть этот стол.'; enabled = false; return }
      if (event.code === 4004) { status.value = 'not-found'; errorMessage.value = 'Стол не найден или уже закрыт.'; enabled = false; return }
      scheduleReconnect()
    }
  }

  function requestState() {
    if (socket.value?.readyState === WebSocket.OPEN) socket.value.send(JSON.stringify({ version: 1, type: 'REQUEST_STATE' }))
  }

  function sendAction(action: OnlineAction): boolean {
    if (pendingActionId.value || socket.value?.readyState !== WebSocket.OPEN) return false
    const actionId = createOnlineActionId()
    pendingActionId.value = actionId
    try {
      socket.value.send(JSON.stringify(actionMessage(actionId, stateVersion, action)))
      return true
    } catch {
      pendingActionId.value = null
      scheduleReconnect()
      return false
    }
  }

  function startHand(): boolean {
    if (socket.value?.readyState !== WebSocket.OPEN) return false
    try {
      socket.value.send(JSON.stringify(startHandMessage(stateVersion)))
      return true
    } catch {
      scheduleReconnect()
      return false
    }
  }

  function reconnect() {
    enabled = true
    attempt = 0
    closeSocket()
    connect()
  }

  function disconnect() {
    enabled = false
    closeSocket()
    status.value = 'disconnected'
  }

  onMounted(() => {
    mounted = true
    connect()
  })
  onBeforeUnmount(() => {
    mounted = false
    disconnect()
  })

  return { status, errorMessage, pendingActionId, socket, connect, reconnect, disconnect, requestState, sendAction, startHand }
}
