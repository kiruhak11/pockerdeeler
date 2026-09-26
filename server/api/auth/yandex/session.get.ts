import { getHeader } from 'h3'
import { accountCookie } from '../../../utils/accountCookie'
import { getYandexSession } from '../../../services/yandexIdentityService'

export default defineEventHandler(async event => {
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(getHeader(event, 'authorization') || '')?.[1]
  const token = bearer || accountCookie(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Yandex session недействительна' })
  const session = await getYandexSession(token)
  return { ...session, signedAuthAvailable: Boolean(process.env.YANDEX_GAMES_SECRET?.trim()) }
})
