import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getYandexReadiness } from '../server/utils/yandexReadiness'

test('guest stays ready when signed Yandex auth and embedding configuration are absent', () => {
  const status = getYandexReadiness({ NODE_ENV: 'production' })
  assert.equal(status.guestReady, true)
  assert.equal(status.signedAuthReady, false)
  assert.equal(status.embeddingReady, false)
  assert.equal(status.rewardedWired, true)
  assert.equal(status.appIdConfigured, false)
  assert.equal(status.mockMode, 'OFF')
  assert.equal(JSON.stringify(status).includes('secret'), false)
})

test('embedding accepts configured exact HTTPS origins and a canonical HTTPS app URL', () => {
  const status = getYandexReadiness({
    NODE_ENV: 'production',
    YANDEX_GAMES_SECRET: 'do-not-return-this',
    YANDEX_GAMES_FRAME_ANCESTORS: 'https://draft.example https://games.example',
    NUXT_PUBLIC_APP_URL: 'https://pocker.example',
    YANDEX_GAMES_APP_ID: 'draft-only-metadata'
  })
  assert.equal(status.signedAuthReady, true)
  assert.equal(status.embeddingReady, true)
  assert.equal(status.appIdConfigured, true)
  assert.equal(JSON.stringify(status).includes('do-not-return-this'), false)
  assert.equal(JSON.stringify(status).includes('draft-only-metadata'), false)
})

test('wildcard/invalid origins block embedding without affecting guest readiness', () => {
  for (const frameAncestors of ['*', 'https://*.example', 'http://games.example']) {
    const status = getYandexReadiness({
      NODE_ENV: 'production',
      YANDEX_GAMES_FRAME_ANCESTORS: frameAncestors,
      NUXT_PUBLIC_APP_URL: 'http://pocker.example'
    })
    assert.equal(status.embeddingReady, false)
    assert.equal(status.guestReady, true)
  }
})

test('production mock flags are reported as disabled', () => {
  const status = getYandexReadiness({
    NODE_ENV: 'production',
    NUXT_PUBLIC_YANDEX_GAMES_MOCK: 'authorized',
    YANDEX_GAMES_DEV_MOCK: 'true'
  })
  assert.equal(status.mockMode, 'OFF')
})

test('standalone top-level preview degrades to the Pocker guest shell without enabling platform-only actions', async () => {
  const page = await readFile(new URL('../app/pages/yandex.vue', import.meta.url), 'utf8')
  const adapter = await readFile(new URL('../app/platform/yandexGames.ts', import.meta.url), 'utf8')
  assert.match(adapter, /if \(this\.options\.host\.isTopLevel\(\)\) return/)
  assert.match(page, /if \(adapter\(\)\.isSdkAvailable\) await adapter\(\)\.gameReady\(\)/)
  assert.match(page, /await ensureYandexSession\(\)/)
  assert.match(page, /Прямой запуск открыт как гость/)
  assert.match(page, /rewardedBusy \|\| route\.path !== '\/yandex' \|\| !adapter\(\)\.isSdkAvailable/)
  assert.match(page, /!accountAuthorized && signedAuthAvailable && adapter\(\)\.isSdkAvailable/)
})
