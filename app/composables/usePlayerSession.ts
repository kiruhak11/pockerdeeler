import { usePlayerSessionStore } from "~/stores/playerSession"

export function usePlayerSession() {
  const store = usePlayerSessionStore()

  onMounted(() => {
    store.loadSession()
  })

  return {
    roomCode: computed(() => store.roomCode),
    playerId: computed(() => store.playerId),
    participantId: computed(() => store.participantId),
    role: computed(() => store.role),
    token: computed(() => store.token),
    dealerSecret: computed(() => store.dealerSecret),
    saveSession: store.saveSession,
    loadSession: store.loadSession,
    clearSession: store.clearSession
  }
}
