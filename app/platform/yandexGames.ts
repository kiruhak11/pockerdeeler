import {
  APPLICATION_PLATFORMS,
  type GamePlatformAdapter,
  type PlatformPlayerIdentity
} from './types'

export const YANDEX_GAMES_SDK_URL = 'https://sdk.games.s3.yandex.net/sdk.js'
export type YandexMockMode = 'off' | 'guest' | 'authorized'

type YandexPlayer = {
  isAuthorized(): boolean
  getUniqueID(): string
  getName?(): string
  getPhoto?(size?: 'small' | 'medium' | 'large'): string
  signature?: string
}

type YandexGamesSdk = {
  getPlayer(options?: { signed?: boolean }): Promise<YandexPlayer>
  auth: { openAuthDialog(): Promise<void> }
  features?: {
    LoadingAPI?: { ready(): void | Promise<void> }
    GameplayAPI?: { start(): void; stop(): void }
  }
}

type YaGamesGlobal = { init(): Promise<YandexGamesSdk> }

type BrowserSdkHost = {
  getYaGames(): YaGamesGlobal | undefined
  loadScript(src: string): Promise<void>
}

export type YandexAdapterOptions = Readonly<{
  host: BrowserSdkHost
  mockMode?: YandexMockMode
  production?: boolean
}>

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function identityFromPlayer(player: YandexPlayer, signature?: string): PlatformPlayerIdentity {
  const authorized = player.isAuthorized()
  const displayName = authorized ? optionalText(player.getName?.()) : undefined
  const avatarUrl = authorized ? optionalText(player.getPhoto?.('medium')) : undefined
  return {
    platform: APPLICATION_PLATFORMS.YANDEX_GAMES,
    platformUserId: player.getUniqueID(),
    authorized,
    ...(signature ? { signature } : {}),
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  }
}

function createMockSdk(mode: Exclude<YandexMockMode, 'off'>): YandexGamesSdk {
  let authorized = mode === 'authorized'
  const player: YandexPlayer = {
    isAuthorized: () => authorized,
    getUniqueID: () => authorized ? 'dev-yandex-authorized' : 'dev-yandex-guest',
    getName: () => authorized ? 'Yandex Dev Player' : '',
    getPhoto: () => ''
  }
  return {
    getPlayer: async options => options?.signed ? { ...player, signature: 'dev-mock-authorized-player' } : player,
    auth: { openAuthDialog: async () => { authorized = true } },
    features: {
      LoadingAPI: { ready() {} },
      GameplayAPI: { start() {}, stop() {} }
    }
  }
}

export class YandexGamesPlatformAdapter implements GamePlatformAdapter {
  readonly platform = APPLICATION_PLATFORMS.YANDEX_GAMES
  readonly capabilities = {
    supportsExternalPayments: false,
    supportsExternalLinks: false
  } as const

  private sdk: YandexGamesSdk | null = null
  private initialization: Promise<void> | null = null
  private player: YandexPlayer | null = null
  private readySent = false
  private gameplayActive = false

  constructor(private readonly options: YandexAdapterOptions) {}

  initialize(): Promise<void> {
    if (this.sdk && this.player) return Promise.resolve()
    if (this.initialization) return this.initialization
    this.initialization = this.initializeOnce().catch((error) => {
      this.initialization = null
      throw error
    })
    return this.initialization
  }

  private async initializeOnce(): Promise<void> {
    const mockMode = this.options.production ? 'off' : (this.options.mockMode ?? 'off')
    if (mockMode !== 'off') {
      this.sdk = createMockSdk(mockMode)
    } else if (!this.sdk) {
      if (!this.options.host.getYaGames()) await this.options.host.loadScript(YANDEX_GAMES_SDK_URL)
      const yaGames = this.options.host.getYaGames()
      if (!yaGames) throw new Error('Yandex Games SDK is unavailable')
      this.sdk = await yaGames.init()
    }
    this.player = await this.sdk!.getPlayer()
  }

  async getPlayerIdentity(): Promise<PlatformPlayerIdentity | null> {
    await this.initialize()
    return this.player ? identityFromPlayer(this.player) : null
  }

  async requestAuthorization(): Promise<PlatformPlayerIdentity | null> {
    await this.initialize()
    if (!this.sdk || !this.player) return null
    if (!this.player.isAuthorized()) {
      await this.sdk.auth.openAuthDialog()
      this.player = await this.sdk.getPlayer()
    }
    if (!this.player.isAuthorized()) return identityFromPlayer(this.player)
    this.player = await this.sdk.getPlayer({ signed: true })
    return identityFromPlayer(this.player, this.player.signature)
  }

  async gameReady(): Promise<void> {
    await this.initialize()
    if (this.readySent) return
    this.readySent = true
    await this.sdk?.features?.LoadingAPI?.ready()
  }

  gameplayStart(): void {
    if (!this.sdk || this.gameplayActive) return
    this.gameplayActive = true
    this.sdk.features?.GameplayAPI?.start()
  }

  gameplayStop(): void {
    if (!this.sdk || !this.gameplayActive) return
    this.gameplayActive = false
    this.sdk.features?.GameplayAPI?.stop()
  }
}

let browserScriptPromise: Promise<void> | null = null

function browserHost(): BrowserSdkHost {
  const getYaGames = () => (window as typeof window & { YaGames?: YaGamesGlobal }).YaGames
  return {
    getYaGames,
    loadScript: (src) => {
      if (browserScriptPromise) return browserScriptPromise
      browserScriptPromise = new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
        const script = existing ?? document.createElement('script')
        const fail = () => {
          if (!existing) script.remove()
          browserScriptPromise = null
          reject(new Error('Не удалось загрузить Yandex Games SDK'))
        }
        script.addEventListener('load', () => {
          if (!getYaGames()) return fail()
          resolve()
        }, { once: true })
        script.addEventListener('error', fail, { once: true })
        if (existing) {
          fail()
        } else {
          script.src = src
          script.async = true
          document.head.append(script)
        }
      })
      return browserScriptPromise
    }
  }
}

let browserAdapter: YandexGamesPlatformAdapter | null = null

export function getBrowserYandexGamesAdapter(options: { mockMode?: YandexMockMode; production: boolean }): YandexGamesPlatformAdapter {
  if (!browserAdapter) browserAdapter = new YandexGamesPlatformAdapter({ host: browserHost(), ...options })
  return browserAdapter
}
