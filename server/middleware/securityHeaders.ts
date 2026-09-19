import { setResponseHeader } from 'h3'

export default defineEventHandler(event => {
  setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  setResponseHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  setResponseHeader(event, 'Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // Nuxt emits a small inline bootstrap/payload script during SSR hydration.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:"
  ].join('; '))
  setResponseHeader(event, 'X-Powered-By', '')
})
