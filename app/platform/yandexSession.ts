import type { AccountUser } from '~/types/account'
import { useAccountStore } from '~/stores/account'

const STORAGE_KEY = 'pocker-yandex-session-v1'

export function readYandexSessionToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const token = localStorage.getItem(STORAGE_KEY)
    return token && /^[A-Za-z0-9_-]{40,100}$/.test(token) ? token : null
  } catch { return null }
}

export function writeYandexSessionToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* browser storage can be disabled */ }
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
