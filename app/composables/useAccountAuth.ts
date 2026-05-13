import { useAccountStore } from '~/stores/account'
import type { AccountUser } from '~/types/account'

export function useAccountAuth() {
  const accountStore = useAccountStore()

  async function register(username: string, password: string) {
    const response = await $fetch<{ user: AccountUser; token: string }>('/api/auth/register', {
      method: 'POST',
      body: { username, password }
    })

    accountStore.saveSession({
      token: response.token,
      user: response.user
    })

    return response.user
  }

  async function login(username: string, password: string) {
    const response = await $fetch<{ user: AccountUser; token: string }>('/api/auth/login', {
      method: 'POST',
      body: { username, password }
    })

    accountStore.saveSession({
      token: response.token,
      user: response.user
    })

    return response.user
  }

  async function loadMe() {
    if (!accountStore.token) {
      return null
    }

    const response = await $fetch<{ user: AccountUser }>('/api/auth/me', {
      method: 'POST',
      body: { token: accountStore.token }
    })
    accountStore.setUser(response.user)
    return response.user
  }

  async function resetBalance(payload?: { roomCode?: string; playerId?: string }) {
    if (!accountStore.token) {
      throw new Error('Нет токена аккаунта')
    }

    const response = await $fetch<{ user: AccountUser }>('/api/auth/reset-balance', {
      method: 'POST',
      body: {
        token: accountStore.token,
        roomCode: payload?.roomCode,
        playerId: payload?.playerId
      }
    })

    accountStore.setUser(response.user)
    return response.user
  }

  function logout() {
    accountStore.clearSession()
  }

  return {
    register,
    login,
    loadMe,
    resetBalance,
    logout
  }
}
