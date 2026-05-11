interface PlayerSessionState {
  roomCode: string | null
  playerId: string | null
  participantId: string | null
  role: 'dealer' | 'player' | 'spectator' | null
  token: string | null
  dealerSecret: string | null
}

const STORAGE_KEY = 'poker-online-session-v1'

export const usePlayerSessionStore = defineStore('playerSession', {
  state: (): PlayerSessionState => ({
    roomCode: null,
    playerId: null,
    participantId: null,
    role: null,
    token: null,
    dealerSecret: null
  }),

  actions: {
    saveSession(payload: PlayerSessionState) {
      this.roomCode = payload.roomCode
      this.playerId = payload.playerId
      this.participantId = payload.participantId
      this.role = payload.role
      this.token = payload.token
      this.dealerSecret = payload.dealerSecret

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      }
    },

    loadSession() {
      if (typeof localStorage === 'undefined') {
        return
      }

      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return
      }

      try {
        const parsed = JSON.parse(raw) as PlayerSessionState
        this.roomCode = parsed.roomCode
        this.playerId = parsed.playerId
        this.participantId = parsed.participantId
        this.role = parsed.role
        this.token = parsed.token
        this.dealerSecret = parsed.dealerSecret
      } catch {
        // ignore broken session
      }
    },

    clearSession() {
      this.roomCode = null
      this.playerId = null
      this.participantId = null
      this.role = null
      this.token = null
      this.dealerSecret = null

      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY)
      }
    }
  }
})
