const DEVELOPMENT_FALLBACK = 'dev-pepper'
const REJECTED_PRODUCTION_VALUES = new Set([
  'dev-pepper',
  'dev-room-pepper',
  'change-me-room-pepper',
  'change-me'
])

export const ROOM_SECRET_PEPPER_ERROR = 'ROOM_SECRET_PEPPER is required in production.'

export type RoomSecretEnvironment = Readonly<Record<string, string | undefined>>

/** Resolves the pepper without ever accepting a known placeholder in production. */
export function resolveRoomSecretPepper(environment: RoomSecretEnvironment = process.env): string {
  const configured = environment.ROOM_SECRET_PEPPER
  if (environment.NODE_ENV === 'production') {
    if (!configured || configured.trim().length === 0 || REJECTED_PRODUCTION_VALUES.has(configured.trim().toLowerCase())) {
      throw new Error(ROOM_SECRET_PEPPER_ERROR)
    }
    return configured
  }
  return configured || DEVELOPMENT_FALLBACK
}

/** Runs at Nitro startup so production fails before serving room requests. */
export function validateRoomSecretPepper(environment: RoomSecretEnvironment = process.env): void {
  resolveRoomSecretPepper(environment)
}
