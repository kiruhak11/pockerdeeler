import { createError, getRequestIP, setResponseHeader, type H3Event } from 'h3'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

function cleanup(now: number) {
  if (buckets.size < 2000) return
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export function assertRateLimit(
  event: H3Event,
  scope: string,
  options: { limit: number; windowMs?: number; subject?: string }
) {
  const now = Date.now()
  const windowMs = options.windowMs ?? 60_000
  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const key = `${scope}:${options.subject || ip}`
  let bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }
  bucket.count += 1
  cleanup(now)

  if (bucket.count > options.limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({ statusCode: 429, statusMessage: `Слишком много запросов. Повторите через ${retryAfter} сек.` })
  }
}
