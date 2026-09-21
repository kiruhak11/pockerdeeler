import { createHash } from 'node:crypto'
import { createError, getRequestHeader, setResponseHeader, type H3Event } from 'h3'
import Redis from 'ioredis'
import { resolvePhoneSourceIp } from './phoneStartLimit'

export const PAYMENT_WEBHOOK_RATE_LIMITS = {
  paymentId: { requests: 12, windowMs: 10 * 60 * 1000 },
  sourceIp: { requests: 300, windowMs: 60 * 1000 },
  global: { requests: 1200, windowMs: 60 * 1000 }
} as const

type LimitConfig = typeof PAYMENT_WEBHOOK_RATE_LIMITS
export type PaymentWebhookCounterResult = { allowed: boolean; retryAfterMs: number }

// The three counters are checked and incremented atomically. Rejected
// requests do not spend quota, and every counter expires after its own window.
const consumeScript = `
local paymentCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local sourceCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local globalCount = tonumber(redis.call('GET', KEYS[3]) or '0')
if paymentCount >= tonumber(ARGV[1]) or sourceCount >= tonumber(ARGV[2]) or globalCount >= tonumber(ARGV[3]) then
  local paymentTtl = paymentCount >= tonumber(ARGV[1]) and redis.call('PTTL', KEYS[1]) or 0
  local sourceTtl = sourceCount >= tonumber(ARGV[2]) and redis.call('PTTL', KEYS[2]) or 0
  local globalTtl = globalCount >= tonumber(ARGV[3]) and redis.call('PTTL', KEYS[3]) or 0
  return {0, math.max(paymentTtl, sourceTtl, globalTtl, 1000)}
end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[5]) end
if redis.call('INCR', KEYS[3]) == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[6]) end
return {1, 0}
`

let redis: Redis | undefined
let connecting: Promise<void> | undefined

export function closePaymentWebhookRateLimitStore(): void {
  redis?.disconnect()
  redis = undefined
  connecting = undefined
}

function redisClient(): Redis {
  if (!process.env.REDIS_URL) throw createError({ statusCode: 503, message: 'Проверка платежа временно недоступна' })
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    })
    // Keep connection errors from becoming unhandled event warnings.
    redis.on('error', () => {})
  }
  return redis
}

function counterKey(kind: 'payment' | 'source' | 'global', value: string): string {
  return `pocker:payment-webhook:v1:${kind}:${createHash('sha256').update(value).digest('hex')}`
}

export async function consumePaymentWebhookCounters(paymentId: string, sourceIp: string, limits: LimitConfig = PAYMENT_WEBHOOK_RATE_LIMITS): Promise<PaymentWebhookCounterResult> {
  try {
    const client = redisClient()
    if (client.status === 'wait' || client.status === 'end') {
      connecting ??= client.connect().finally(() => { connecting = undefined })
      await connecting
    } else if (client.status === 'connecting' && connecting) await connecting
    if (client.status !== 'ready') throw new Error('Redis is not ready')
    const result = await client.eval(
      consumeScript, 3,
      counterKey('payment', paymentId), counterKey('source', sourceIp), counterKey('global', 'all'),
      limits.paymentId.requests, limits.sourceIp.requests, limits.global.requests,
      limits.paymentId.windowMs, limits.sourceIp.windowMs, limits.global.windowMs
    )
    if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(Number(result[0])) || !Number.isFinite(Number(result[1]))) throw new Error('Invalid Redis response')
    return { allowed: Number(result[0]) === 1, retryAfterMs: Number(result[1]) }
  } catch {
    // Fail closed: an unavailable shared counter must never allow an unbounded
    // stream of requests to the paid payment provider.
    throw createError({ statusCode: 503, message: 'Проверка платежа временно недоступна. Повторите позднее' })
  }
}

function trustedProxyIps() {
  // Keep the existing production proxy configuration as a fallback while
  // allowing payment webhooks to use a separate explicit setting later.
  return process.env.PAYMENT_WEBHOOK_TRUSTED_PROXY_IPS ?? process.env.PHONE_TRUSTED_PROXY_IPS ?? ''
}

export function resolvePaymentWebhookSourceIp(event: H3Event): string {
  return resolvePhoneSourceIp(
    event.node.req.socket.remoteAddress,
    getRequestHeader(event, 'x-real-ip'),
    trustedProxyIps()
  )
}

export async function assertPaymentWebhookRateLimit(event: H3Event, paymentId: string): Promise<void> {
  const sourceIp = resolvePaymentWebhookSourceIp(event)
  let result: PaymentWebhookCounterResult
  try {
    result = await consumePaymentWebhookCounters(paymentId, sourceIp)
  } catch {
    throw createError({ statusCode: 503, message: 'Проверка платежа временно недоступна. Повторите позднее' })
  }
  if (!result.allowed) {
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
    setResponseHeader(event, 'Retry-After', seconds)
    throw createError({ statusCode: 429, message: 'Слишком много webhook-запросов. Повторите позднее', data: { retryAfter: seconds } })
  }
}
