import { getHeader, readBody } from 'h3'
import { assertSameOrigin, accountCookie } from '../../../utils/accountCookie'
import { assertYandexAuthLimit } from '../../../utils/yandexAuthLimit'
import { exchangeYandexIdentity } from '../../../services/yandexIdentityService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  await assertYandexAuthLimit(event, 'exchange', 10, 5 * 60_000)
  const authorization = getHeader(event, 'authorization') || ''
  const currentToken = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] || accountCookie(event)
  if (!currentToken) throw createError({ statusCode: 401, statusMessage: 'Сначала создайте гостевую сессию' })
  const body = await readBody<{ signature?: unknown }>(event)
  if (typeof body?.signature !== 'string' || body.signature.length > 24_000) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректная подпись игрока Яндекс' })
  }
  return exchangeYandexIdentity({ currentToken, signature: body.signature })
})
