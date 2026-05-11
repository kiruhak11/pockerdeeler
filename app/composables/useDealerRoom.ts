import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"

export function useDealerRoom(roomCode: MaybeRefOrGetter<string | undefined>) {
  const roomStore = useRoomStore()
  const sessionStore = usePlayerSessionStore()

  const code = computed(() => toValue(roomCode)?.trim().toUpperCase())

  async function callDealerRoute(path: string, payload: Record<string, unknown> = {}) {
    const currentCode = code.value
    if (!currentCode) {
      throw new Error('Код комнаты отсутствует')
    }

    const dealerSecret = sessionStore.dealerSecret
    if (!dealerSecret) {
      throw new Error('dealerSecret не найден')
    }

    const response = await $fetch<{ success: boolean; state: unknown }>(`/api/rooms/${currentCode}/${path}`, {
      method: 'POST',
      body: {
        dealerSecret,
        ...payload
      }
    })

    if (response.state) {
      roomStore.setRoomState(response.state as Parameters<typeof roomStore.setRoomState>[0])
    }

    return response
  }

  async function createRoom(payload: {
    name: string
    startingStack: number
    smallBlind?: number
    bigBlind?: number
    maxPlayers: number
    allowLateJoin: boolean
    requireDealerActionApproval: boolean
    allowSpectators: boolean
  }) {
    return $fetch('/api/rooms/create', {
      method: 'POST',
      body: payload
    })
  }

  async function startGame() {
    return callDealerRoute('start-game')
  }

  async function startHand() {
    return callDealerRoute('start-hand')
  }

  async function approveAction(pendingActionId: string) {
    return callDealerRoute('dealer-action', {
      pendingActionId,
      decision: 'approve'
    })
  }

  async function rejectAction(pendingActionId: string) {
    return callDealerRoute('dealer-action', {
      pendingActionId,
      decision: 'reject'
    })
  }

  async function finishHand() {
    return callDealerRoute('finish-hand')
  }

  async function distributePot(winners: string[]) {
    return callDealerRoute('distribute-pot', {
      winners
    })
  }

  async function undo() {
    return callDealerRoute('undo')
  }

  async function leaveAsDealer() {
    const currentCode = code.value
    if (!currentCode) {
      return
    }

    await $fetch(`/api/rooms/${currentCode}/leave`, {
      method: 'POST',
      body: {
        dealerSecret: sessionStore.dealerSecret
      }
    })
  }

  return {
    createRoom,
    startGame,
    startHand,
    approveAction,
    rejectAction,
    finishHand,
    distributePot,
    undo,
    leaveAsDealer
  }
}
