import { getYandexReadiness } from '../utils/yandexReadiness'

export default defineNitroPlugin(() => {
  const status = getYandexReadiness()
  console.info([
    '[yandex-games]',
    `guest=${status.guestReady ? 'READY' : 'BLOCKED'}`,
    `signed-auth=${status.signedAuthReady ? 'READY' : 'DISABLED_NO_SECRET'}`,
    `embedding=${status.embeddingReady ? 'READY' : 'BLOCKED_CONFIG'}`,
    `rewarded=${status.rewardedWired ? 'WIRED_RUNTIME_CHECK' : 'BLOCKED'}`,
    `app-id=${status.appIdConfigured ? 'CONFIGURED' : 'OPTIONAL_UNSET'}`,
    `mock=${status.mockMode}`
  ].join(' '))
})
