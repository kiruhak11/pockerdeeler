import { readBody, setResponseHeader } from 'h3'
import { accountCookie, assertSameOrigin, COOKIE_MARKER } from '../utils/accountCookie'

export default defineEventHandler(async event => {
  if (!event.path.startsWith('/api/')) return
  setResponseHeader(event, 'Cache-Control', 'no-store, private')
  const cookie = accountCookie(event)
  if (!cookie) return
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.method)) assertSameOrigin(event)
  if (event.headers.get('authorization') === `Bearer ${COOKIE_MARKER}`) event.node.req.headers.authorization = `Bearer ${cookie}`
  if (['POST', 'PUT', 'PATCH'].includes(event.method) && event.headers.get('content-type')?.includes('application/json')) {
    const body = await readBody(event)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const key of ['token', 'accountToken', 'authToken']) if (body[key] === COOKIE_MARKER) body[key] = cookie
    }
  }
})
