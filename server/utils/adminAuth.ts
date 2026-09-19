import { createError, type H3Event } from 'h3'
import { accountCookie, assertSameOrigin } from './accountCookie'
import { getUserByToken, verifyPassword } from '../services/userAccountService'

export async function requireAdmin(event: H3Event, superOnly = false) {
  const user = await getUserByToken(accountCookie(event))
  if (!user.phoneVerifiedAt || user.mustChangePassword || !['ADMIN', 'SUPERADMIN'].includes(user.role) || (superOnly && user.role !== 'SUPERADMIN')) throw createError({ statusCode: 403, message: 'Необходим подтверждённый аккаунт администратора' })
  if (event.method !== 'GET') assertSameOrigin(event)
  return user
}
export function reauthenticate(password: string, passwordHash: string) {
  if (!verifyPassword(password, passwordHash)) throw createError({ statusCode: 403, message: 'Подтвердите текущий пароль' })
}
export const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v))
