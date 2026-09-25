import { getHeader, readBody } from 'h3'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { assertYandexAuthLimit } from '../../../utils/yandexAuthLimit'
import { createOrResumeYandexGuest } from '../../../services/yandexIdentityService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  await assertYandexAuthLimit(event, 'guest', 20, 5 * 60_000)
  const body = await readBody<{ resumeToken?: unknown }>(event)
  const headerToken = /^Bearer\s+([^\s]+)$/i.exec(getHeader(event, 'authorization') || '')?.[1]
  const resumeToken = headerToken || (typeof body?.resumeToken === 'string' ? body.resumeToken : undefined)
  if (resumeToken && (!/^[A-Za-z0-9_-]{40,100}$/.test(resumeToken))) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректная гостевая сессия' })
  }
  return createOrResumeYandexGuest(resumeToken)
})
