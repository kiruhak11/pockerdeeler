import { parseYandexFrameAncestors, websocketOrigin } from '../middleware/securityHeaders'

export type YandexReadiness = Readonly<{
  guestReady: true
  signedAuthReady: boolean
  embeddingReady: boolean
  rewardedWired: true
  appIdConfigured: boolean
  mockMode: 'OFF' | 'CLIENT' | 'SERVER' | 'CLIENT_AND_SERVER'
}>

/** Safe startup diagnostics only: never return or log configured secret/origin values. */
export function getYandexReadiness(env: NodeJS.ProcessEnv = process.env): YandexReadiness {
  const production = env.NODE_ENV === 'production'
  const clientMock = !production && ['guest', 'authorized'].includes(env.NUXT_PUBLIC_YANDEX_GAMES_MOCK || '')
  const serverMock = !production && env.YANDEX_GAMES_DEV_MOCK === 'true'
  const mockMode = clientMock && serverMock ? 'CLIENT_AND_SERVER'
    : clientMock ? 'CLIENT'
      : serverMock ? 'SERVER' : 'OFF'

  return {
    guestReady: true,
    signedAuthReady: Boolean(env.YANDEX_GAMES_SECRET?.trim()),
    embeddingReady: parseYandexFrameAncestors(env.YANDEX_GAMES_FRAME_ANCESTORS, env.NODE_ENV).length > 0
      && Boolean(websocketOrigin(env.NUXT_PUBLIC_APP_URL, env.NODE_ENV)),
    rewardedWired: true,
    appIdConfigured: Boolean(env.YANDEX_GAMES_APP_ID?.trim()),
    mockMode
  }
}
