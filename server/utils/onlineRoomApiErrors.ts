import { createError } from 'h3'
import { OnlineRoomApiError } from '../services/onlineRoomApiService'

/** Keeps domain/runtime failures controlled at the HTTP boundary. */
export function throwOnlineRoomApiError(error: unknown): never {
  if (error instanceof OnlineRoomApiError) {
    throw createError({ statusCode: error.statusCode, statusMessage: error.message })
  }
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === 'number') throw error
  throw createError({ statusCode: 503, statusMessage: 'Online room service is temporarily unavailable.' })
}
