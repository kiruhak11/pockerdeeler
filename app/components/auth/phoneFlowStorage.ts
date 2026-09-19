import type { PhonePurpose, PhoneVerification } from '~/types/account'

export interface SavedPhoneFlow {
  purpose: PhonePurpose
  phone: string
  requestId: string
  verification: PhoneVerification | null
  completing?: boolean
}

export function readPhoneFlow(key: string): SavedPhoneFlow | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as SavedPhoneFlow | null
    return value && ['register', 'recover', 'link'].includes(value.purpose) && typeof value.phone === 'string' && typeof value.requestId === 'string' ? value : null
  } catch { return null }
}

export function writePhoneFlow(key: string, value: SavedPhoneFlow | null) {
  if (value) localStorage.setItem(key, JSON.stringify(value))
  else localStorage.removeItem(key)
}
