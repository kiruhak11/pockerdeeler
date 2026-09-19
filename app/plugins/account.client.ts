import { useAccountStore } from '~/stores/account'
export default defineNuxtPlugin((nuxtApp) => {
  const account = useAccountStore()
  // Do not mutate Pinia before hydration. SSR renders the anonymous shell;
  // loading the HttpOnly session after mount keeps the first client tree equal.
  nuxtApp.hook('app:mounted', () => {
    void (async () => {
      try {
        const { user } = await $fetch('/api/auth/session')
        account.saveSession({ user, token: 'cookie-session' })
      } catch { account.clearSession() }
    })()
  })
})
