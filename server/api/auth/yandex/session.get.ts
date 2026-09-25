import { getHeader } from 'h3'
import { accountCookie } from '../../../utils/accountCookie'
import { getYandexSession } from '../../../services/yandexIdentityService'

export default defineEventHandler(event => {
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(getHeader(event, 'authorization') || '')?.[1]
  const token = bearer || accountCookie(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Yandex session недействительна' })
  return getYandexSession(token)
})
