import type { Game } from '~/types/game'

const STORAGE_KEY = 'poker-dealer-game-v1'

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export function saveGameToStorage(game: Game | null): void {
  if (!canUseStorage()) {
    return
  }

  if (!game) {
    localStorage.removeItem(STORAGE_KEY)
    return
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(game))
}

export function loadGameFromStorage(): Game | null {
  if (!canUseStorage()) {
    return null
  }

  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Game
    if (!parsed || !Array.isArray(parsed.players)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function clearGameFromStorage(): void {
  if (!canUseStorage()) {
    return
  }

  localStorage.removeItem(STORAGE_KEY)
}

export function hasSavedGame(): boolean {
  if (!canUseStorage()) {
    return false
  }

  return Boolean(localStorage.getItem(STORAGE_KEY))
}
