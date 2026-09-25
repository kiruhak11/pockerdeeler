import { PWA_PREFERENCES_KEY, parsePwaPreferences } from '~/composables/usePwaPreferences'
import { platformFromPath } from '~/platform/types'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default defineNuxtPlugin(nuxtApp => {
  const route = useRoute()
  if (platformFromPath(route.path) === 'YANDEX_GAMES') return
  const { state, persist, openInstallHelp, openOnboarding } = usePwa()
  const { safeToUpdate } = usePwaSafety()
  let deferred: InstallPromptEvent | null = null
  let registration: ServiceWorkerRegistration | undefined
  let reloadRequested = false
  let lastUpdateCheck = 0
  const cleanup: (() => void)[] = []
  function listen(target: EventTarget, name: string, handler: EventListener) {
    target.addEventListener(name, handler)
    cleanup.push(() => target.removeEventListener(name, handler))
  }
  try { state.value.preferences = parsePwaPreferences(localStorage.getItem(PWA_PREFERENCES_KEY)) } catch { /* Storage may be blocked. */ }
  const ua = navigator.userAgent
  state.value.ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  state.value.embedded = /FBAN|FBAV|Instagram|Line\/|Telegram|MicroMessenger|; wv\)/i.test(ua)
    || (state.value.ios && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua))
  state.value.safari = state.value.ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !state.value.embedded
  const standalone = matchMedia('(display-mode: standalone)')
  async function refreshReachability() {
    // navigator.onLine describes the user's network, while this request describes
    // the app server. Keep them separate so an unavailable health endpoint is not
    // shown as a false "no internet" state.
    if (!navigator.onLine) {
      state.value.serverReachable = false
      return
    }
    try {
      await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      state.value.serverReachable = true
    } catch {
      state.value.serverReachable = false
    }
  }
  function refreshEnvironment() {
    state.value.online = navigator.onLine
    state.value.visible = document.visibilityState === 'visible'
    state.value.standalone = standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (state.value.standalone) {
      state.value.preferences.standaloneObserved = true
      persist()
      if (state.value.dialog === 'install') state.value.dialog = null
    }
    if (registration && state.value.visible && state.value.online && Date.now() - lastUpdateCheck > 60 * 60 * 1000) {
      lastUpdateCheck = Date.now()
      void registration.update().catch(() => {})
    }
    void refreshReachability()
  }
  refreshEnvironment()
  for (const name of ['online', 'offline', 'pageshow']) listen(window, name, refreshEnvironment)
  listen(document, 'visibilitychange', refreshEnvironment)
  listen(standalone, 'change', refreshEnvironment)
  listen(window, 'storage', event => {
    if ((event as StorageEvent).key === PWA_PREFERENCES_KEY) {
      state.value.preferences = parsePwaPreferences((event as StorageEvent).newValue)
      if (state.value.preferences.installSuppressed && state.value.dialog === 'install') state.value.dialog = null
    }
  })
  listen(window, 'poker:install-help', openInstallHelp)
  listen(window, 'poker:how-to-play', openOnboarding)
  listen(window, 'beforeinstallprompt', event => {
    event.preventDefault()
    deferred = event as InstallPromptEvent
    state.value.canPrompt = true
  })
  listen(window, 'appinstalled', () => {
    deferred = null
    state.value.canPrompt = false
    state.value.installedThisSession = true
    state.value.dialog = null
  })
  listen(window, 'poker:install', () => {
    const prompt = deferred
    if (!prompt || state.value.standalone) return
    deferred = null
    state.value.canPrompt = false
    void (async () => {
      try {
        await prompt.prompt()
        const choice = await prompt.userChoice
        state.value.message = choice.outcome === 'accepted' ? 'Если установка завершена, откройте игру с экрана Домой.' : 'Можно продолжить в браузере.'
      } catch { state.value.message = 'Используйте инструкцию установки через меню браузера.' }
    })()
  })
  listen(window, 'poker:update', () => {
    if (!safeToUpdate.value || state.value.updating) return
    if (!registration?.waiting) {
      if (state.value.updateReady) window.location.reload()
      return
    }
    state.value.updating = true
    state.value.message = ''
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => {
      state.value.updating = false
      reloadRequested = false
      state.value.message = 'Не удалось применить обновление. Попробуйте ещё раз.'
      channel.port1.close()
    }, 8000)
    channel.port1.onmessage = event => {
      clearTimeout(timeout)
      channel.port1.close()
      if (!event.data?.accepted) {
        state.value.updating = false
        state.value.message = 'Сначала выйдите с игровых экранов во всех вкладках. Раздача не будет прервана.'
      } else reloadRequested = true
    }
    registration.waiting.postMessage({ type: 'POKER_ACTIVATE_UPDATE' }, [channel.port2])
  })
  // Nuxt must not auto-reload a live hand after an old lazy chunk disappears.
  nuxtApp.hook('app:chunkError', () => {
    state.value.updateReady = true
    state.value.message = 'Нужна новая версия приложения. Обновите после выхода с игрового экрана.'
  })
  nuxtApp.hook('app:mounted', async () => {
    state.value.ready = true
    if (import.meta.dev || !window.isSecureContext || !('serviceWorker' in navigator)) return
    try {
      const existing = await navigator.serviceWorker.getRegistration('/')
      const worker = existing?.active || existing?.waiting || existing?.installing
      // Do not replace an unrelated worker if an installation already exists.
      if (worker && new URL(worker.scriptURL).pathname !== '/sw.js') return
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      state.value.updateReady = Boolean(registration.waiting)
      const checkOffline = async () => {
        try {
          state.value.offlineReady = Boolean(await caches.match('/setup/index.html'))
        } catch { state.value.offlineReady = false }
      }
      void checkOffline()
      listen(registration, 'updatefound', () => {
        const installing = registration?.installing
        if (!installing) return
        listen(installing, 'statechange', () => {
          if (installing.state === 'installed') {
            state.value.updateReady = Boolean(registration?.waiting && navigator.serviceWorker.controller)
            void checkOffline()
          }
        })
      })
      listen(navigator.serviceWorker, 'controllerchange', () => {
        void checkOffline()
        state.value.updating = false
        if (reloadRequested && safeToUpdate.value) window.location.reload()
        else if (reloadRequested) state.value.updateReady = true
        reloadRequested = false
      })
    } catch {
      state.value.message = 'Офлайн-оболочка пока недоступна. Можно продолжить с интернетом.'
    }
  })
  if (import.meta.hot) import.meta.hot.dispose(() => cleanup.forEach(dispose => dispose()))
})
