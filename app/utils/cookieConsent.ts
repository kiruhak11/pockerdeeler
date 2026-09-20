export const COOKIE_CONSENT_COOKIE = 'pocker_cookie_consent'

export type CookiePreferences = {
  policyVersion: string
  analyticsAllowed: boolean
  updatedAt: string
}

export function createCookiePreferences(analyticsAllowed: boolean, now = new Date()): CookiePreferences {
  return {
    policyVersion: '',
    analyticsAllowed: Boolean(analyticsAllowed),
    updatedAt: now.toISOString()
  }
}

export function withPolicyVersion(preferences: CookiePreferences, policyVersion: string): CookiePreferences {
  return { ...preferences, policyVersion }
}

export function getCurrentCookiePreferences(stored: unknown, currentPolicyVersion: string): CookiePreferences | null {
  if (!stored || typeof stored !== 'object') return null
  const candidate = stored as Partial<CookiePreferences>
  if (candidate.policyVersion !== currentPolicyVersion || typeof candidate.analyticsAllowed !== 'boolean' || typeof candidate.updatedAt !== 'string') return null
  return {
    policyVersion: candidate.policyVersion,
    analyticsAllowed: candidate.analyticsAllowed,
    updatedAt: candidate.updatedAt
  }
}
