import { PWA_PREFERENCES_KEY, parsePwaPreferences } from './usePwaPreferences'

export function usePwa() {
  const state = useState('poker-pwa', () => ({
    ready: false,
    standalone: false,
    installedThisSession: false,
    ios: false,
    safari: false,
    embedded: false,
    online: true,
    serverReachable: true,
    visible: true,
    canPrompt: false,
    updateReady: false,
    updating: false,
    offlineReady: false,
    message: '',
    dialog: null as 'install' | 'onboarding' | null,
    preferences: parsePwaPreferences(null)
  }))

  function persist() {
    try { localStorage.setItem(PWA_PREFERENCES_KEY, JSON.stringify(state.value.preferences)) } catch { /* Private browsing still works in memory. */ }
  }
  function openInstallHelp() {
    if (state.value.standalone) return
    state.value.dialog = 'install'
  }
  function openOnboarding() { state.value.dialog = 'onboarding' }
  function dismissInstall(suppress = false) {
    state.value.preferences.lastInstallProposal = Date.now()
    if (suppress) state.value.preferences.installSuppressed = true
    persist()
    state.value.dialog = null
  }
  return { state, persist, openInstallHelp, openOnboarding, dismissInstall }
}
