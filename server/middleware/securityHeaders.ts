import { defineEventHandler, getRequestURL, setResponseHeader } from 'h3'

const YANDEX_SDK_ORIGIN = 'https://sdk.games.s3.yandex.net'

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Parse exact origins only. A bad entry rejects the whole list so a typo cannot widen policy. */
export function parseYandexFrameAncestors(raw: string | undefined, nodeEnv = process.env.NODE_ENV): string[] {
  if (!raw?.trim()) return []
  const entries = raw.trim().split(/\s+/)
  const result: string[] = []
  for (const entry of entries) {
    if (entry.includes('*')) return []
    let parsed: URL
    try { parsed = new URL(entry) } catch { return [] }
    const devLoopback = nodeEnv === 'development' && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
    if ((!devLoopback && parsed.protocol !== 'https:') || parsed.origin !== entry || parsed.username || parsed.password) return []
    result.push(parsed.origin)
  }
  return [...new Set(result)]
}

export function websocketOrigin(appUrl: string | undefined, nodeEnv: string | undefined): string | undefined {
  if (!appUrl) return undefined
  try {
    const parsed = new URL(appUrl)
    const devLoopback = nodeEnv === 'development' && parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)
    if (parsed.protocol !== 'https:' && !devLoopback) return undefined
    if (parsed.username || parsed.password) return undefined
    return `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}`
  } catch { return undefined }
}

export type SecurityPolicy = Readonly<{ csp: string; xFrameOptions?: 'DENY' }>

export function securityPolicyForPath(pathname: string, env: NodeJS.ProcessEnv = process.env): SecurityPolicy {
  const isYandex = pathname === '/yandex' || pathname.startsWith('/yandex/')
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${isYandex ? (parseYandexFrameAncestors(env.YANDEX_GAMES_FRAME_ANCESTORS, env.NODE_ENV).join(' ') || "'none'") : "'none'"}`,
    "object-src 'none'",
    // Nuxt emits a small inline bootstrap/payload script during SSR hydration.
    `script-src 'self' 'unsafe-inline'${isYandex ? ` ${YANDEX_SDK_ORIGIN}` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self'${isYandex ? ` ${websocketOrigin(env.NUXT_PUBLIC_APP_URL, env.NODE_ENV) || ''}` : ' ws: wss:'}`
  ]
  return { csp: directives.join('; '), ...(isYandex ? {} : { xFrameOptions: 'DENY' as const }) }
}

export default defineEventHandler((event) => {
  const policy = securityPolicyForPath(getRequestURL(event).pathname)
  setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  setResponseHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  setResponseHeader(event, 'Content-Security-Policy', policy.csp)
  if (policy.xFrameOptions) setResponseHeader(event, 'X-Frame-Options', policy.xFrameOptions)
  setResponseHeader(event, 'X-Powered-By', '')
})
