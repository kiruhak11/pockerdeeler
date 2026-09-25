import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { platformFromPath } from '../app/platform/types'
import { webPlatformAdapter } from '../app/platform/web'
import { YANDEX_GAMES_SDK_URL, YandexGamesPlatformAdapter } from '../app/platform/yandexGames'

function fixture(options: { authorized?: boolean; failLoad?: boolean; rewardedVideo?: (callbacks: { onOpen(): void; onRewarded(): void; onClose(wasShown: boolean): void; onError(error: unknown): void }) => void } = {}) {
  let authorized = Boolean(options.authorized)
  const calls = { load: 0, init: 0, player: 0, signed: 0, auth: 0, ready: 0, start: 0, stop: 0 }
  const player = {
    isAuthorized: () => authorized,
    getUniqueID: () => 'yandex-user-1',
    getName: () => 'Player',
    getPhoto: () => 'https://example.test/avatar.png'
  }
  const sdk = {
    getPlayer: async (options?: { signed?: boolean }) => { calls.player++; if (options?.signed) { calls.signed++; return { ...player, signature: 'signed-profile' } } return player },
    auth: { openAuthDialog: async () => { calls.auth++; authorized = true } },
    adv: { showRewardedVideo: ({ callbacks }: { callbacks: Parameters<NonNullable<typeof options.rewardedVideo>>[0] }) => {
      if (options.rewardedVideo) options.rewardedVideo(callbacks)
      else { callbacks.onOpen(); callbacks.onRewarded(); callbacks.onClose(true) }
    } },
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
  assert.equal(platformFromPath('/online/ROOM1', 'YANDEX_GAMES'), 'YANDEX_GAMES')
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
  assert.equal(authorized?.signature, 'signed-profile')
  assert.equal(calls.signed, 1)
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

test('rewarded progress outcome requires onRewarded; onOpen/onClose wasShown alone do not count', async () => {
  const closed = fixture({ rewardedVideo: callbacks => { callbacks.onOpen(); callbacks.onClose(true) } })
  await closed.adapter.initialize()
  let closedRewardCallbacks = 0
  assert.equal(await closed.adapter.showRewardedVideo(async () => { closedRewardCallbacks += 1 }), 'closed')
  assert.equal(closedRewardCallbacks, 0)

  const rewarded = fixture({ rewardedVideo: callbacks => { callbacks.onOpen(); callbacks.onRewarded(); callbacks.onClose(false) } })
  await rewarded.adapter.initialize()
  let rewardCallbacks = 0
  assert.equal(await rewarded.adapter.showRewardedVideo(async () => { rewardCallbacks += 1 }), 'rewarded')
  assert.equal(rewardCallbacks, 1)

  const errored = fixture({ rewardedVideo: callbacks => callbacks.onError(new Error('no ad')) })
  await errored.adapter.initialize()
  let errorRewardCallbacks = 0
  assert.equal(await errored.adapter.showRewardedVideo(async () => { errorRewardCallbacks += 1 }), 'error')
  assert.equal(errorRewardCallbacks, 0)
})

test('rewarded video suspends active GameplayAPI state and restores it on close', async () => {
  const { adapter, calls } = fixture()
  await adapter.initialize()
  adapter.gameplayStart()
  assert.equal(await adapter.showRewardedVideo(async () => {}), 'rewarded')
  assert.deepEqual({ start: calls.start, stop: calls.stop }, { start: 2, stop: 1 })
})

test('rewarded endpoints are Yandex-session-only, rate-limited, and accept no client reward amount', async () => {
  const startRoute = await readFile(new URL('../server/api/yandex/rewarded/start.post.ts', import.meta.url), 'utf8')
  const completeRoute = await readFile(new URL('../server/api/yandex/rewarded/[attemptId]/complete.post.ts', import.meta.url), 'utf8')
  const service = await readFile(new URL('../server/services/yandexRewardedService.ts', import.meta.url), 'utf8')
  const page = await readFile(new URL('../app/pages/yandex.vue', import.meta.url), 'utf8')
  assert.match(startRoute, /assertSameOrigin/)
  assert.match(startRoute, /assertYandexAuthLimit/)
  assert.match(startRoute, /requireYandexBearer/)
  assert.match(startRoute, /z\.object\(\{ requestId: z\.string\(\)\.uuid\(\) \}\)\.strict\(\)/)
  assert.doesNotMatch(startRoute, /amount|userId/)
  assert.match(completeRoute, /assertYandexAuthLimit/)
  assert.doesNotMatch(completeRoute, /readBody|amount|userId/)
  assert.match(service, /accountOrigin !== 'YANDEX_GAMES'/)
  assert.match(service, /YANDEX_REWARDED_GRANT_AMOUNT = 10_000n/)
  assert.match(service, /lockUserWallet\(tx, user\.id\)/)
  assert.match(service, /YANDEX_REWARDED_AD_REWARD/)
  assert.match(page, /route\.path !== '\/yandex'/)
  assert.match(page, /rewardedBusy \|\| route\.path !== '\/yandex'/)
  assert.match(page, /onRewarded|showRewardedVideo/)
  assert.match(page, /Награда — внутренняя виртуальная валюта Pocker/)
  assert.match(page, /body: \{ requestId: crypto\.randomUUID\(\) \}/)
  assert.doesNotMatch(page, /wallet\.balance\s*\+\s*10_?000|body:.*(?:amount|chips)/)
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
  assert.match(accountPlugin, /platformFromPath\(route\.path, route\.query\.platform\) === 'YANDEX_GAMES'/)
  assert.match(premiumPlugin, /platformFromPath\(route\.path, route\.query\.platform\) === 'YANDEX_GAMES'/)
  assert.match(pwaPlugin, /platformFromPath\(route\.path, route\.query\.platform\) === 'YANDEX_GAMES'/)
})
