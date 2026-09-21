import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { createError, getRequestHeader, setResponseHeader, type H3Event } from 'h3'
import Redis from 'ioredis'

export const PHONE_START_LIMITS = {
  phone: { requests: 3, windowMs: 60 * 60 * 1000 },
  ip: { requests: 30, windowMs: 60 * 60 * 1000 }
} as const
type LimitConfig = { phone: { requests: number; windowMs: number }; ip: { requests: number; windowMs: number } }

type CounterResult = { allowed: boolean; retryAfterMs: number }
type ConsumeCounters = (phone: string, ip: string) => Promise<CounterResult>

// Both counters are checked and incremented in one Redis operation. A rejected
// request does not spend either counter, and each key expires after its window.
const consumeScript = `
local phoneCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local ipCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if phoneCount >= tonumber(ARGV[1]) or ipCount >= tonumber(ARGV[2]) then
  local phoneTtl = phoneCount >= tonumber(ARGV[1]) and redis.call('PTTL', KEYS[1]) or 0
  local ipTtl = ipCount >= tonumber(ARGV[2]) and redis.call('PTTL', KEYS[2]) or 0
  return {0, math.max(phoneTtl, ipTtl, 1000)}
end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[4]) end
return {1, 0}
`

let redis: Redis | undefined
let connecting: Promise<void> | undefined
export function closePhoneStartLimitStore(): void {
  redis?.disconnect()
  redis = undefined
  connecting = undefined
}
function redisClient(): Redis {
  if (!process.env.REDIS_URL) throw createError({ statusCode: 503, message: 'Проверка телефона временно недоступна' })
  redis ??= new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  })
  // The request receives the connection error from connect()/eval(); keep
  // ioredis from emitting an additional unhandled-error warning.
  redis.on('error', () => {})
  return redis
}

function counterKey(kind: 'phone' | 'ip', value: string): string {
  return `pocker:phone-start:v1:${kind}:${createHash('sha256').update(value).digest('hex')}`
}

export async function consumePhoneStartCounters(phone: string, ip: string, limits: LimitConfig = PHONE_START_LIMITS): Promise<CounterResult> {
  try {
    const client = redisClient()
    if (client.status === 'wait' || client.status === 'end') {
      connecting ??= client.connect().finally(() => { connecting = undefined })
      await connecting
    } else if (client.status === 'connecting' && connecting) await connecting
    if (client.status !== 'ready') throw new Error('Redis is not ready')
    const result = await client.eval(
      consumeScript, 2, counterKey('phone', phone), counterKey('ip', ip),
      limits.phone.requests, limits.ip.requests,
      limits.phone.windowMs, limits.ip.windowMs
    )
    if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(Number(result[0])) || !Number.isFinite(Number(result[1]))) throw new Error('Invalid Redis response')
    return { allowed: Number(result[0]) === 1, retryAfterMs: Number(result[1]) }
  } catch {
    // Fail closed: an unavailable shared counter must never allow unbounded
    // calls to the paid phone verification provider.
    throw createError({ statusCode: 503, message: 'Проверка телефона временно недоступна. Повторите позднее' })
  }
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null
  const candidate = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value
  return isIP(candidate) ? candidate.toLowerCase() : null
}

export function resolvePhoneSourceIp(peerAddress: string | undefined, realIpHeader: string | undefined, trustedProxyIps = process.env.PHONE_TRUSTED_PROXY_IPS || ''): string {
  const peer = normalizeIp(peerAddress)
  if (!peer) throw createError({ statusCode: 503, message: 'Не удалось определить адрес подключения' })
  const trusted = trustedProxyIps.split(',').map(value => value.trim()).filter(Boolean).map(normalizeIp)
  if (trusted.includes(null)) throw createError({ statusCode: 503, message: 'Некорректна настройка доверенных proxy' })
  if (!trusted.includes(peer)) return peer
  // Only a trusted reverse proxy may set X-Real-IP. It must overwrite any
  // client-supplied value with its own $remote_addr, never pass it through.
  const source = normalizeIp(realIpHeader)
  if (!source) throw createError({ statusCode: 503, message: 'Proxy не передал адрес клиента' })
  return source
}

export async function checkPhoneStartQuota(phone: string, ip: string, consume: ConsumeCounters = consumePhoneStartCounters): Promise<CounterResult> {
  let result: CounterResult
  try { result = await consume(phone, ip) }
  catch { throw createError({ statusCode: 503, message: 'Проверка телефона временно недоступна. Повторите позднее' }) }
  if (!result.allowed) {
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
    throw createError({ statusCode: 429, message: 'Слишком много запросов на проверку телефона. Повторите позднее', data: { retryAfter: seconds } })
  }
  return result
}

export async function assertPhoneStartLimit(event: H3Event, phone: string): Promise<void> {
  const peer = event.node.req.socket.remoteAddress
  const ip = resolvePhoneSourceIp(peer, getRequestHeader(event, 'x-real-ip'))
  try {
    await checkPhoneStartQuota(phone, ip)
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) {
      const seconds = (error as { data?: { retryAfter?: number } }).data?.retryAfter
      if (seconds) setResponseHeader(event, 'Retry-After', seconds)
    }
    throw error
  }
}
