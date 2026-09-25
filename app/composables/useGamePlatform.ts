import { platformFromPath } from '~/platform/types'

export function useGamePlatform() {
  const route = useRoute()
  const platform = computed(() => platformFromPath(route.path))
  const isYandexGames = computed(() => platform.value === 'YANDEX_GAMES')
  return { platform: readonly(platform), isYandexGames: readonly(isYandexGames) }
}
