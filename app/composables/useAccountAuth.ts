import { useAccountStore } from '~/stores/account'
import type { AccountUser, PhonePurpose, PhoneVerification } from '~/types/account'

export function normalizeRussianPhone(value: string): string {
  const digits = value.replace(/[\s()+-]/g, '')
  if (!/^[78]\d{10}$/.test(digits)) throw new Error('Введите российский номер: +7 и ещё 10 цифр')
  return '+7' + digits.slice(1)
}

export function formatRussianPhone(value: string | null | undefined): string {
  if (!value) return 'Не указан'
  try {
    const phone = normalizeRussianPhone(value)
    return `${phone.slice(0, 2)} (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`
  } catch { return value }
}

export function useAccountAuth() {
  const accountStore = useAccountStore()

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
    try {
      const response = await $fetch<{ user: AccountUser | null }>('/api/auth/session')
      accountStore.setUser(response.user)
      return response.user
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
      if (status === 401 || status === 403) {
        accountStore.clearSession()
        return null
      }
      throw error
    }
  }

  function startPhone(phone: string, purpose: PhonePurpose, requestId: string) {
    return $fetch<PhoneVerification>('/api/auth/phone/start', {
      method: 'POST', body: { phone: normalizeRussianPhone(phone), purpose, requestId }, retry: 0
    })
  }

  function phoneStatus(id: string) {
    return $fetch<PhoneVerification>('/api/auth/phone/status', { method: 'POST', body: { id }, retry: 0 })
  }

  async function completePhone(id: string, password: string, username?: string) {
    if (password.length < 12 || password.length > 128) throw new Error('Пароль: от 12 до 128 символов')
    const response = await $fetch<{ user: AccountUser; token: string }>('/api/auth/phone/complete', {
      method: 'POST', body: { id, password, ...(username ? { username } : {}) }, retry: 0
    })
    accountStore.saveSession(response)
    return response.user
  }

  async function updateUsername(username: string) {
    if (!accountStore.token) {
      throw new Error('Нет токена аккаунта')
    }

    const response = await $fetch<{ user: AccountUser }>('/api/auth/update-username', {
      method: 'POST',
      body: {
        token: accountStore.token,
        username
      }
    })

    accountStore.setUser(response.user)
    return response.user
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    if (newPassword.length < 12 || newPassword.length > 128) throw new Error('Пароль: от 12 до 128 символов')
    if (!accountStore.token) {
      throw new Error('Нет токена аккаунта')
    }

    return $fetch<{ success: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: {
        token: accountStore.token,
        currentPassword,
        newPassword
      }
    })
  }

  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    accountStore.clearSession()
  }

  return {
    startPhone,
    phoneStatus,
    completePhone,
    login,
    loadMe,
    updateUsername,
    changePassword,
    logout
  }
}
