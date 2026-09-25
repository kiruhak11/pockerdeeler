export const APPLICATION_PLATFORMS = {
  WEB: 'WEB',
  YANDEX_GAMES: 'YANDEX_GAMES'
} as const

export type ApplicationPlatform = typeof APPLICATION_PLATFORMS[keyof typeof APPLICATION_PLATFORMS]

export type PlatformPlayerIdentity = Readonly<{
  platform: ApplicationPlatform
  platformUserId: string
  authorized: boolean
  displayName?: string
  avatarUrl?: string
}>

export type PlatformCapabilities = Readonly<{
  supportsExternalPayments: boolean
  supportsExternalLinks: boolean
}>

export interface GamePlatformAdapter {
  readonly platform: ApplicationPlatform
  readonly capabilities: PlatformCapabilities
  initialize(): Promise<void>
  getPlayerIdentity(): Promise<PlatformPlayerIdentity | null>
  requestAuthorization(): Promise<PlatformPlayerIdentity | null>
  gameReady(): Promise<void>
  gameplayStart(): void
  gameplayStop(): void
}

export function platformFromPath(path: string): ApplicationPlatform {
  return path === '/yandex' || path.startsWith('/yandex/')
    ? APPLICATION_PLATFORMS.YANDEX_GAMES
    : APPLICATION_PLATFORMS.WEB
}
