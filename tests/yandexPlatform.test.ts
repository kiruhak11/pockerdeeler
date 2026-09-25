import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { platformFromPath } from '../app/platform/types'
import { webPlatformAdapter } from '../app/platform/web'
import { YANDEX_GAMES_SDK_URL, YandexGamesPlatformAdapter } from '../app/platform/yandexGames'

function fixture(options: { authorized?: boolean; failLoad?: boolean } = {}) {
  let authorized = Boolean(options.authorized)
  const calls = { load: 0, init: 0, player: 0, auth: 0, ready: 0, start: 0, stop: 0 }
  const player = {
    isAuthorized: () => authorized,
    getUniqueID: () => 'yandex-user-1',
    getName: () => 'Player',
    getPhoto: () => 'https://example.test/avatar.png'
  }
  const sdk = {
    getPlayer: async () => { calls.player++; return player },
    auth: { openAuthDialog: async () => { calls.auth++; authorized = true } },
    features: {
      LoadingAPI: { ready: () => { calls.ready++ } },
      GameplayAPI: { start: () => { calls.start++ }, stop: () => { calls.stop++ } }
    }
  }
  let globalAvailable = false
  const host = {
    getYaGames: () => globalAvailable ? { init: async () => { calls.init++; return sdk } } : undefined,
    loadScript: async (src: string) => {
      calls.load++
      assert.equal(src, YANDEX_GAMES_SDK_URL)
      if (options.failLoad) throw new Error('load failed')
      globalAvailable = true
    }
  }
  return { adapter: new YandexGamesPlatformAdapter({ host }), calls }
}

test('WEB mode is independent from the Yandex SDK', async () => {
  assert.equal(platformFromPath('/'), 'WEB')
  assert.equal(platformFromPath('/premium'), 'WEB')
  assert.equal(webPlatformAdapter.capabilities.supportsExternalPayments, true)
  await webPlatformAdapter.initialize()
})

test('/yandex selects YANDEX_GAMES with restricted capabilities', () => {
  const { adapter } = fixture()
  assert.equal(platformFromPath('/yandex'), 'YANDEX_GAMES')
  assert.equal(platformFromPath('/yandex/online'), 'YANDEX_GAMES')
  assert.equal(adapter.capabilities.supportsExternalPayments, false)
  assert.equal(adapter.capabilities.supportsExternalLinks, false)
})

test('SDK initialization is a singleton and Game Ready is sent exactly once', async () => {
  const { adapter, calls } = fixture()
  await Promise.all([adapter.initialize(), adapter.initialize(), adapter.initialize()])
  await Promise.all([adapter.gameReady(), adapter.gameReady()])
  assert.deepEqual({ load: calls.load, init: calls.init, player: calls.player, ready: calls.ready }, { load: 1, init: 1, player: 1, ready: 1 })
})

test('guest initialization never opens auth and authorization requires an explicit call', async () => {
  const { adapter, calls } = fixture()
  const guest = await adapter.getPlayerIdentity()
  assert.equal(guest?.authorized, false)
  assert.equal(guest?.displayName, undefined)
  assert.equal(calls.auth, 0)

  const authorized = await adapter.requestAuthorization()
  assert.equal(calls.auth, 1)
  assert.equal(authorized?.authorized, true)
  assert.equal(authorized?.displayName, 'Player')
})

test('gameplay events are stateful and initialization can be retried', async () => {
  const { adapter, calls } = fixture()
  adapter.gameplayStart()
  await adapter.initialize()
  adapter.gameplayStart()
  adapter.gameplayStart()
  adapter.gameplayStop()
  adapter.gameplayStop()
  assert.deepEqual({ start: calls.start, stop: calls.stop }, { start: 1, stop: 1 })

  let attempts = 0
  const retryAdapter = new YandexGamesPlatformAdapter({
    host: {
      getYaGames: () => attempts > 0 ? { init: async () => ({
        getPlayer: async () => ({ isAuthorized: () => false, getUniqueID: () => 'guest' }),
        auth: { openAuthDialog: async () => {} }
      }) } : undefined,
      loadScript: async () => { attempts++; if (attempts === 1) throw new Error('first failure') }
    }
  })
  await assert.rejects(retryAdapter.initialize())
  await retryAdapter.initialize()
})

test('production never enables the development mock', async () => {
  let loads = 0
  const adapter = new YandexGamesPlatformAdapter({
    production: true,
    mockMode: 'authorized',
    host: { getYaGames: () => undefined, loadScript: async () => { loads++; throw new Error('SDK unavailable') } }
  })
  await assert.rejects(adapter.initialize())
  assert.equal(loads, 1)
})

test('Yandex shell has no web auth, RUB payments, or external navigation', async () => {
  const shell = await readFile(new URL('../app/pages/yandex.vue', import.meta.url), 'utf8')
  for (const forbidden of ['/login', 'PhoneVerificationForm', 'YooKassa', 'ЮKassa', '/premium', 'App Store', 'Google Play', 'pocker.kiruhak11.ru', 'target="_blank"']) {
    assert.equal(shell.includes(forbidden), false, `unexpected Yandex shell content: ${forbidden}`)
  }
  assert.match(shell, /@click="authorize"/)
  assert.match(shell, /platform-mode="yandex"/)
})

test('global web chrome and web-only bootstrap are disabled for the Yandex route', async () => {
  const [appShell, accountPlugin, premiumPlugin, pwaPlugin] = await Promise.all([
    readFile(new URL('../app/app.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/plugins/account.client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/plugins/premium-theme.client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/plugins/pwa.client.ts', import.meta.url), 'utf8')
  ])
  assert.match(appShell, /<LegalFooter v-if="!isYandexGames"/)
  assert.match(appShell, /<CookieConsentManager v-if="!isYandexGames"/)
  assert.match(appShell, /<BottomNav v-if="!isOnlineTable && !isYandexGames"/)
  assert.match(accountPlugin, /platformFromPath\(route\.path\) === 'YANDEX_GAMES'/)
  assert.match(premiumPlugin, /platformFromPath\(route\.path\) === 'YANDEX_GAMES'/)
  assert.match(pwaPlugin, /platformFromPath\(route\.path\) === 'YANDEX_GAMES'/)
})
