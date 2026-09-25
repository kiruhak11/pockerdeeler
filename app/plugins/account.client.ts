import { useAccountStore } from '~/stores/account'
import { platformFromPath } from '~/platform/types'
export default defineNuxtPlugin((nuxtApp) => {
  const account = useAccountStore()
  const route = useRoute()
  // Do not mutate Pinia before hydration. SSR renders the anonymous shell;
  // loading the HttpOnly session after mount keeps the first client tree equal.
  nuxtApp.hook('app:mounted', () => {
    if (platformFromPath(route.path, route.query.platform) === 'YANDEX_GAMES') return
    void (async () => {
      try {
        const { user } = await $fetch('/api/auth/session')
        account.saveSession({ user, token: 'cookie-session' })
      } catch { account.clearSession() }
    })()
  })
})
