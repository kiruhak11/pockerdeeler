/* The production build injects a content-derived version and public asset allowlist. */
const build = self.__POKER_PWA__ || { version: 'unbuilt', assets: ['/offline.html'] }
const prefix = 'poker-desk-static-'
const cacheName = prefix + build.version
const allowed = new Set(build.assets)

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    for (const path of allowed) {
      const response = await fetch(new Request(path, { credentials: 'omit', cache: 'reload' }))
      if (!response.ok || response.redirected || response.type === 'opaque') throw new Error('Incomplete PWA shell')
      await cache.put(path, response)
    }
    // Deliberately no skipWaiting: updates must not interrupt an existing game.
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Keep the previous build's hashed chunks for clients that have not reloaded.
    const previous = (await caches.keys()).filter(key => key.startsWith(prefix) && key !== cacheName)
    for (const key of previous.slice(0, -1)) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data?.type !== 'POKER_ACTIVATE_UPDATE') return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Fail closed across tabs, including sleeping iOS tabs and other participants.
    // A hidden stale room tab must not trap the user on an old build.
    const blocked = windows.some(client => client.visibilityState === 'visible' && /^\/(?:room(?:\/|$)|game(?:\/|$)|setup(?:\/|$))/.test(new URL(client.url).pathname))
    event.ports[0]?.postMessage({ accepted: !blocked })
    if (!blocked) await self.skipWaiting()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('authorization')) return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // Never put a navigation response (including SSR state) into a cache.
        return await fetch(request)
      } catch {
        const cache = await caches.open(cacheName)
        if (/^\/(?:setup|game|history)\/?$/.test(url.pathname)) {
          const shell = await cache.match('/setup/index.html')
          if (shell) return shell
        }
        return (await cache.match('/offline.html')) || new Response('Нет сети. Онлайн-комнате нужен интернет.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    })())
    return
  }
  // No API, auth, account, admin, JSON payloads, ads, external fonts, or runtime HTML.
  if (url.search || !allowed.has(url.pathname)) {
    // Hashed static chunks from the previous build are read-only compatibility assets.
    if (!url.search && /^\/_nuxt\/[^/]+\.(?:js|css)$/.test(url.pathname)) {
      event.respondWith((async () => {
        for (const key of (await caches.keys()).filter(key => key.startsWith(prefix))) {
          const cached = await (await caches.open(key)).match(request)
          if (cached) return cached
        }
        return fetch(request)
      })())
    }
    return
  }
  event.respondWith((async () => (await (await caches.open(cacheName)).match(url.pathname)) || fetch(request))())
})
