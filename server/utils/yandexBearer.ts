import { createError, getHeader, type H3Event } from 'h3'

export function requireYandexBearer(event: H3Event): string {
  const token = /^Bearer\s+([^\s]+)$/i.exec(getHeader(event, 'authorization') || '')?.[1]
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Требуется Yandex session' })
  return token
}
