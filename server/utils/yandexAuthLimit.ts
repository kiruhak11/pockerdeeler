import { createHash } from 'node:crypto'
import { createError, getRequestIP, setResponseHeader, type H3Event } from 'h3'
import Redis from 'ioredis'
import { assertRateLimit } from './rateLimit'

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`
let redis: Redis | undefined
let connecting: Promise<void> | undefined

/** Use the shared Redis counter in deployed environments; retain the existing local limiter for dev. */
export async function assertYandexAuthLimit(event: H3Event, scope: 'guest' | 'exchange', limit: number, windowMs: number): Promise<void> {
  if (!process.env.REDIS_URL) {
    assertRateLimit(event, `yandex-${scope}`, { limit, windowMs })
    return
  }
  try {
    redis ??= new Redis(process.env.REDIS_URL, {
      lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1000,
      maxRetriesPerRequest: 1, retryStrategy: () => null
    })
    redis.on('error', () => {})
    if (redis.status === 'wait' || redis.status === 'end') {
      connecting ??= redis.connect().finally(() => { connecting = undefined })
      await connecting
    } else if (redis.status === 'connecting' && connecting) await connecting
    if (redis.status !== 'ready') throw new Error('Redis unavailable')
    const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
    const key = createHash('sha256').update(`${scope}:${ip}`).digest('hex')
    const result = await redis.eval(incrementScript, 1, `pocker:yandex-auth:v1:${key}`, windowMs)
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid Redis rate-limit response')
    const count = Number(result[0])
    if (!Number.isSafeInteger(count)) throw new Error('Invalid Redis rate-limit count')
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil(Number(result[1]) / 1000))
      setResponseHeader(event, 'Retry-After', retryAfter)
      throw createError({ statusCode: 429, statusMessage: `Слишком много запросов. Повторите через ${retryAfter} сек.` })
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 429) throw error
    throw createError({ statusCode: 503, statusMessage: 'Проверка частоты запросов временно недоступна' })
  }
}
