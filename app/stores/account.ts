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
      this.token = payload.user ? 'cookie-session' : null
      this.user = payload.user
      this.loadSession()
    },
    loadSession() {
      if (typeof localStorage === 'undefined') {
        return
      }

      try {
        // Authentication is restored from the HttpOnly cookie, never browser storage.
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // Storage may be disabled in private browsing.
      }
    },
    setUser(user: AccountUser | null) {
      this.user = user
      this.token = user ? 'cookie-session' : null
      this.loadSession()
    },
    clearSession() {
      this.token = null
      this.user = null
      this.loadSession()
    }
  }
})
