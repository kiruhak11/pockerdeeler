import type { AccountUser } from '~/types/account'
import { useAccountStore } from '~/stores/account'

const STORAGE_KEY = 'pocker-yandex-session-v1'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/
let inMemoryToken: string | null = null

export function readYandexSessionToken(): string | null {
  if (inMemoryToken && TOKEN_PATTERN.test(inMemoryToken)) return inMemoryToken
  if (typeof localStorage === 'undefined') return null
  try {
    const token = localStorage.getItem(STORAGE_KEY)
    inMemoryToken = token && TOKEN_PATTERN.test(token) ? token : null
    return inMemoryToken
  } catch { return inMemoryToken }
}

export function writeYandexSessionToken(token: string | null): void {
  inMemoryToken = token && TOKEN_PATTERN.test(token) ? token : null
  if (typeof localStorage === 'undefined') return
  try { if (inMemoryToken) localStorage.setItem(STORAGE_KEY, inMemoryToken); else localStorage.removeItem(STORAGE_KEY) }
  catch { /* Browser storage may be partitioned or disabled in an iframe; memory still serves this run. */ }
}

export function yandexAuthHeaders(enabled = true): Record<string, string> {
  if (!enabled) return {}
  const token = readYandexSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function applyYandexAccountSession(user: AccountUser): void {
  const account = useAccountStore()
  account.setUser(user)
}

export async function ensureYandexSession(): Promise<AccountUser> {
  const token = readYandexSessionToken()
  if (token) {
    try {
      const result = await $fetch<{ user: AccountUser }>('/api/auth/yandex/session', { headers: { Authorization: `Bearer ${token}` }, retry: 0 })
      applyYandexAccountSession(result.user)
      return result.user
    } catch { writeYandexSessionToken(null) }
  }
  const result = await $fetch<{ user: AccountUser; token: string }>('/api/auth/yandex/guest', { method: 'POST', body: {}, retry: 0 })
  writeYandexSessionToken(result.token)
  applyYandexAccountSession(result.user)
  return result.user
}

export function saveYandexSession(user: AccountUser, token: string): void {
  writeYandexSessionToken(token)
  applyYandexAccountSession(user)
}
