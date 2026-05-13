import { createClientRequestId } from '~/utils/idempotency'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { useRoomStore } from '~/stores/room'
import type { RoomState } from '~/types/room'

export function usePlayerRoom(roomCode: MaybeRefOrGetter<string | undefined>) {
  const sessionStore = usePlayerSessionStore()
  const roomStore = useRoomStore()

  const code = computed(() => toValue(roomCode)?.trim().toUpperCase())

  async function joinRoom(payload: { name: string; role?: 'player' | 'spectator'; authToken?: string }) {
    const currentCode = code.value
    if (!currentCode) {
      throw new Error('Код комнаты отсутствует')
    }

    return $fetch(`/api/rooms/${currentCode}/join`, {
      method: 'POST',
      body: payload
    })
  }

  async function sendAction(payload: {
    type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'
    amount: number
  }) {
    const currentCode = code.value
    if (!currentCode || !sessionStore.playerId || !sessionStore.token) {
      throw new Error('Сессия игрока не найдена')
    }

    try {
      const response = await $fetch<{
        success: boolean
        state?: RoomState
        action?: {
          status: 'pending' | 'approved' | 'rejected' | 'applied'
        }
      }>(`/api/rooms/${currentCode}/action`, {
        method: 'POST',
        body: {
          playerId: sessionStore.playerId,
          token: sessionStore.token,
          type: payload.type,
          amount: payload.amount,
          clientRequestId: createClientRequestId('action')
        }
      })

      if (response.state) {
        roomStore.setRoomState(response.state)
      }

      return response
    } catch (error) {
      await fetchState().catch(() => undefined)
      throw error
    }
  }

  async function fetchState() {
    const currentCode = code.value
    if (!currentCode) {
      return
    }

    const state = await $fetch(`/api/rooms/${currentCode}/state`)
    roomStore.setRoomState(state)
  }

  async function leaveRoom() {
    const currentCode = code.value
    if (!currentCode || !sessionStore.participantId || !sessionStore.token) {
      return
    }

    await $fetch(`/api/rooms/${currentCode}/leave`, {
      method: 'POST',
      body: {
        participantId: sessionStore.participantId,
        playerId: sessionStore.playerId,
        token: sessionStore.token
      }
    })
  }

  function reconnect() {
    return fetchState()
  }

  return {
    joinRoom,
    sendAction,
    fetchState,
    leaveRoom,
    reconnect
  }
}
