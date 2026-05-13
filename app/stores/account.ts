import type { AccountUser } from '~/types/account'

interface AccountState {
  token: string | null
  user: AccountUser | null
}

const STORAGE_KEY = 'poker-account-session-v1'

export const useAccountStore = defineStore('account', {
  state: (): AccountState => ({
    token: null,
    user: null
  }),
  actions: {
    saveSession(payload: AccountState) {
      this.token = payload.token
      this.user = payload.user

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
        const parsed = JSON.parse(raw) as AccountState
        this.token = parsed.token
        this.user = parsed.user
      } catch {
        // ignore broken session
      }
    },
    setUser(user: AccountUser | null) {
      this.user = user
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          token: this.token,
          user: this.user
        }))
      }
    },
    clearSession() {
      this.token = null
      this.user = null
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY)
      }
    }
  }
})
