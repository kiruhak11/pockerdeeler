export const PWA_PREFERENCES_KEY = 'poker-desk-pwa-v1'
export const ONBOARDING_VERSION = 1
export const INSTALL_RETRY_MS = 24 * 60 * 60 * 1000

export interface PwaPreferences {
  onboardingVersion: number
  onboardingResult: 'completed' | 'skipped' | null
  lastInstallProposal: number
  installSuppressed: boolean
  standaloneObserved: boolean
}

export function parsePwaPreferences(raw: string | null): PwaPreferences {
  const defaults: PwaPreferences = { onboardingVersion: 0, onboardingResult: null, lastInstallProposal: 0, installSuppressed: false, standaloneObserved: false }
  try {
    const value = JSON.parse(raw || '{}')
    if (!value || typeof value !== 'object') return defaults
    return {
      onboardingVersion: Number.isInteger(value.onboardingVersion) && value.onboardingVersion > 0 ? value.onboardingVersion : 0,
      onboardingResult: ['completed', 'skipped'].includes(value.onboardingResult) ? value.onboardingResult : null,
      lastInstallProposal: Number.isFinite(value.lastInstallProposal) && value.lastInstallProposal > 0 ? value.lastInstallProposal : 0,
      installSuppressed: value.installSuppressed === true,
      standaloneObserved: value.standaloneObserved === true
    }
  } catch { return defaults }
}

export function isInstallProposalDue(preferences: PwaPreferences, now: number): boolean {
  return !preferences.installSuppressed && (!preferences.lastInstallProposal || now - preferences.lastInstallProposal >= INSTALL_RETRY_MS)
}
