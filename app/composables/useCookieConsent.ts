import { getLegalDocument } from '~/data/legalDocuments'
import {
  COOKIE_CONSENT_COOKIE,
  type CookiePreferences,
  createCookiePreferences,
  getCurrentCookiePreferences,
  withPolicyVersion
} from '~/utils/cookieConsent'
import { stopOptionalAnalytics } from '~/utils/analyticsGate'

const COOKIE_CONSENT_STATE_KEY = 'pocker-cookie-consent-settings-open'

export function useCookieConsent() {
  const storedPreferences = useCookie<CookiePreferences | null>(COOKIE_CONSENT_COOKIE, {
    default: () => null,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax'
  })
  const settingsOpen = useState<boolean>(COOKIE_CONSENT_STATE_KEY, () => false)
  const currentPolicyVersion = getLegalDocument('cookies')?.version ?? ''
  const preferences = computed(() => getCurrentCookiePreferences(storedPreferences.value, currentPolicyVersion))
  const analyticsAllowed = computed(() => preferences.value?.analyticsAllowed === true)

  function setAnalyticsAllowed(allowed: boolean) {
    storedPreferences.value = withPolicyVersion(createCookiePreferences(allowed), currentPolicyVersion)
    if (!allowed) stopOptionalAnalytics()
    settingsOpen.value = false
  }

  function openPreferences() {
    settingsOpen.value = true
  }

  function closePreferences() {
    settingsOpen.value = false
  }

  return {
    currentPolicyVersion,
    storedPreferences,
    preferences,
    analyticsAllowed,
    settingsOpen,
    hasCurrentConsent: computed(() => preferences.value !== null),
    setAnalyticsAllowed,
    openPreferences,
    closePreferences
  }
}
