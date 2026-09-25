import { getHeader } from 'h3'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { issueWebSocketAuthTicket } from '../../../services/yandexIdentityService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(getHeader(event, 'authorization') || '')?.[1]
  if (!bearer) throw createError({ statusCode: 401, statusMessage: 'Требуется Yandex session' })
  return { ticket: await issueWebSocketAuthTicket(bearer) }
})
