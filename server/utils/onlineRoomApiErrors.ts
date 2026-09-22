import { createError } from 'h3'
import { OnlineRoomApiError } from '../services/onlineRoomApiService'
import { isDatabaseUnavailableError } from './databaseErrors'

/** Keeps domain/runtime failures controlled at the HTTP boundary. */
export function throwOnlineRoomApiError(error: unknown): never {
  if (isDatabaseUnavailableError(error)) {
    throw createError({ statusCode: 503, statusMessage: 'Online room service is temporarily unavailable.' })
  }
  if (error instanceof OnlineRoomApiError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message })
  }
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) throw error
  if (statusCode === 503) {
    throw createError({ statusCode: 503, statusMessage: 'Online room service is temporarily unavailable.' })
  }
  throw createError({ statusCode: 500, statusMessage: 'Internal server error.' })
}
