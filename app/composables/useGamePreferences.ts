const STORAGE_KEY = 'poker-game-preferences-v1'

export interface GamePreferences {
  notifications: boolean
  chatToasts: boolean
  turnVibration: boolean
  turnAutoScroll: boolean
  revealModals: boolean
  handResultModals: boolean
  handsGuide: boolean
  actionLanguage: 'ru' | 'en'
}

const defaults: GamePreferences = {
  notifications: true,
  chatToasts: true,
  turnVibration: true,
  turnAutoScroll: true,
  revealModals: true,
  handResultModals: true,
  handsGuide: true,
  actionLanguage: 'en'
}

const preferences = reactive<GamePreferences>({ ...defaults })
let hydrated = false

export function useGamePreferences() {
  function load() {
    if (!import.meta.client || hydrated) return
    hydrated = true
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<GamePreferences>
      for (const key of Object.keys(defaults) as (keyof GamePreferences)[]) {
        if (key === 'actionLanguage' && (stored[key] === 'ru' || stored[key] === 'en')) preferences[key] = stored[key]
        else if (typeof stored[key] === 'boolean') (preferences[key] as boolean) = stored[key] as boolean
      }
    } catch { /* Private browsing can disable storage. */ }
  }

  function save() {
    if (!import.meta.client) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)) } catch { /* Preferences remain active for this tab. */ }
  }

  function reset() {
    Object.assign(preferences, defaults)
    save()
  }

  onMounted(load)
  return { preferences: readonly(preferences), editablePreferences: preferences, load, save, reset }
}
