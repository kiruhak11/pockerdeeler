import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: process.env.NODE_ENV !== 'production' },
  modules: ['@pinia/nuxt'],
  css: ['~/assets/styles/main.scss'],
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#0c2d20' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: 'Poker Desk' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'icon', type: 'image/svg+xml', href: '/pwa/icon.svg' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/pwa/apple-touch-icon.png' }
      ]
    }
  },
  // Only the client-only local setup shell is prerendered, never account/room HTML.
  routeRules: {
    '/setup': { ssr: false, prerender: true },
    '/game': { ssr: false },
    '/history': { ssr: false },
    '/sw.js': { headers: { 'cache-control': 'no-cache', 'service-worker-allowed': '/' } },
    '/manifest.webmanifest': { headers: { 'cache-control': 'no-cache' } }
  },
  experimental: {
    emitRouteChunkError: 'manual',
    // A self-contained public shell needs no JSON payload/build metadata offline.
    payloadExtraction: false,
    appManifest: false
  },
  hooks: {
    async 'nitro:build:public-assets'(nitro) {
      const dir = nitro.options.output.publicDir
      const files = await readdir(join(dir, '_nuxt'), { recursive: true })
      const assets = files.filter(file => /\.(?:js|css|woff2?)$/.test(file)).map(file => `/_nuxt/${file.replaceAll('\\', '/')}`)
      assets.push('/offline.html', '/manifest.webmanifest', '/pwa/icon.svg', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/maskable-512.png', '/pwa/apple-touch-icon.png')
      // During the prerenderer's build this file does not exist yet.
      try {
        await readFile(join(dir, 'setup/index.html'))
        assets.push('/setup/index.html')
      } catch { /* The final server build includes the generated public shell. */ }
      assets.sort()
      const worker = await readFile(join(nitro.options.rootDir, 'public/sw.js'), 'utf8')
      const hash = createHash('sha256').update(worker)
      for (const asset of assets) hash.update(asset).update(await readFile(join(dir, asset.slice(1))))
      const config = { version: hash.digest('hex').slice(0, 16), assets }
      await writeFile(join(dir, 'sw.js'), `self.__POKER_PWA__ = ${JSON.stringify(config)};\n${worker}`)
    }
  },
  nitro: {
    esbuild: {
      options: {
        target: 'es2020'
      }
    },
    experimental: {
      websocket: true
    }
  },
  pinia: {
    storesDirs: ['./app/stores/**']
  }
})
