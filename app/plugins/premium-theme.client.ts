import { platformFromPath } from '~/platform/types'

export default defineNuxtPlugin(async () => {
  const route = useRoute()
  if (platformFromPath(route.path, route.query.platform) === 'YANDEX_GAMES') return
  delete document.documentElement.dataset.premiumTheme
  delete document.documentElement.dataset.premiumSurface
  try {
    const result = await $fetch<{ locked: boolean; access: { features: string[] }; settings: { theme?: string; interfaceStyle?: string } | null }>('/api/premium/preferences')
    const theme = result.locked ? null : result.settings?.theme
    if (theme && ['classic', 'midnight', 'emerald', 'gold'].includes(theme)) document.documentElement.dataset.premiumTheme = theme
    const surface = result.locked || !result.access.features.includes('VISUAL_SETTINGS') ? null : result.settings?.interfaceStyle
    if (surface && ['standard', 'soft', 'contrast'].includes(surface)) document.documentElement.dataset.premiumSurface = surface
  } catch {
    // Guests and expired subscriptions use the regular site theme.
  }
})
