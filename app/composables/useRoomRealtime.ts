import type { RealtimeEnvelope } from '~/types/realtime'
import { useRoomStore } from '~/stores/room'

export function useRoomRealtime(roomCode: MaybeRefOrGetter<string | undefined>) {
  const roomStore = useRoomStore()
  const ws = ref<WebSocket | null>(null)
  const reconnectTimer = ref<ReturnType<typeof setTimeout> | null>(null)
  const shouldReconnect = ref(true)

  const code = computed(() => toValue(roomCode)?.trim().toUpperCase())

  const connect = () => {
    const currentCode = code.value
    if (!currentCode || typeof window === 'undefined') {
      return
    }

    roomStore.setConnectionStatus('connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/room/${currentCode}`)

    socket.onopen = () => {
      roomStore.setConnectionStatus('connected')
      roomStore.setError(null)
    }

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as RealtimeEnvelope
        if (payload.type === 'room_state_updated' || payload.type === 'room:joined') {
          if (payload.state) {
            roomStore.setRoomState(payload.state)
          }
        }

        if (payload.type === 'room:error') {
          roomStore.setError(payload.message || 'Ошибка обновления комнаты')
        }
      } catch {
        // ignore malformed messages
      }
    }

    socket.onclose = () => {
      roomStore.setConnectionStatus('disconnected')
      ws.value = null

      if (shouldReconnect.value) {
        reconnectTimer.value = setTimeout(() => {
          connect()
        }, 1000)
      }
    }

    socket.onerror = () => {
      roomStore.setConnectionStatus('disconnected')
      roomStore.setError('Потеряно соединение с сервером')
    }

    ws.value = socket
  }

  const disconnect = () => {
    shouldReconnect.value = false
    if (reconnectTimer.value) {
      clearTimeout(reconnectTimer.value)
      reconnectTimer.value = null
    }

    if (ws.value) {
      ws.value.close()
      ws.value = null
    }

    roomStore.setConnectionStatus('disconnected')
  }

  const reconnect = () => {
    disconnect()
    shouldReconnect.value = true
    connect()
  }

  onMounted(() => {
    shouldReconnect.value = true
    connect()
  })

  onBeforeUnmount(() => {
    disconnect()
  })

  return {
    connect,
    disconnect,
    reconnect,
    socket: ws
  }
}
