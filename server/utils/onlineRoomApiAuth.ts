import { createError, type H3Event } from 'h3'
import { accountCookie, assertSameOrigin } from './accountCookie'
import { verifyUserAuthToken } from '../services/userAccountService'
import { isDatabaseUnavailableError } from './databaseErrors'

/** Requires the authenticated account session carried by the HttpOnly cookie. */
export async function requireOnlineRoomUser(event: H3Event): Promise<{ userId: string }> {
  let auth: { userId: string } | null
  try {
    auth = await verifyUserAuthToken(accountCookie(event))
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      throw createError({ statusCode: 503, statusMessage: 'Online room service is temporarily unavailable.' })
    }
    throw error
  }
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return auth
}

/** Mutating browser requests must come from the application origin. */
export function assertOnlineRoomMutationOrigin(event: H3Event): void {
  assertSameOrigin(event)
}
