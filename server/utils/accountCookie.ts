import { getCookie, setCookie, deleteCookie, getRequestURL, createError, type H3Event } from 'h3'
export const ACCOUNT_COOKIE = 'poker_account'
export const COOKIE_MARKER = 'cookie-session'
export function accountCookie(event: H3Event) { return getCookie(event, ACCOUNT_COOKIE) || '' }
// The browser store deliberately keeps only this marker; the real session
// remains HttpOnly. Legacy API clients may still send the opaque token.
export function resolveAccountToken(event: H3Event, token: string) {
  return token === COOKIE_MARKER ? accountCookie(event) : token
}
export function saveAccountCookie(event: H3Event, token: string) {
  setCookie(event, ACCOUNT_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 86400 })
}
export function clearAccountCookie(event: H3Event) { deleteCookie(event, ACCOUNT_COOKIE, { path: '/' }) }
export function assertSameOrigin(event: H3Event) {
  const origin = event.headers.get('origin')
  const allowed = process.env.NUXT_PUBLIC_APP_URL ? new URL(process.env.NUXT_PUBLIC_APP_URL).origin : getRequestURL(event).origin
  if (!origin || (origin !== allowed && origin !== getRequestURL(event).origin)) throw createError({ statusCode: 403, message: 'Запрос должен исходить с этого сайта' })
}
export function isolatedAuthTests() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_LEGACY_TEST_AUTH === 'true' && /(:55439\/|_test)/.test(process.env.DATABASE_URL || '')
}
