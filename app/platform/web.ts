import { APPLICATION_PLATFORMS, type GamePlatformAdapter } from './types'

export const webPlatformAdapter: GamePlatformAdapter = {
  platform: APPLICATION_PLATFORMS.WEB,
  capabilities: {
    supportsExternalPayments: true,
    supportsExternalLinks: true
  },
  async initialize() {},
  async getPlayerIdentity() { return null },
  async requestAuthorization() { return null },
  async gameReady() {},
  gameplayStart() {},
  gameplayStop() {}
}
