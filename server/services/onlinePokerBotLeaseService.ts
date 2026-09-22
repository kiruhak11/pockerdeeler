import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'

export const ONLINE_POKER_BOT_LEASE_PREFIX = 'pocker:online-bot-lease:v1:'
export const ONLINE_POKER_BOT_LEASE_TTL_MS = 8_000

export type OnlinePokerBotLease = Readonly<{
  botKey: string
  ownerId: string
  token: string
  leaseKey: string
}>

export type OnlinePokerBotLeaseServiceOptions = Readonly<{
  redis?: Redis
  redisUrl?: string
  keyPrefix?: string
  ttlMs?: number
  ownerId?: string
}>

const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local fence = redis.call('INCR', KEYS[2])
local token = tostring(fence) .. ':' .. ARGV[1]
redis.call('SET', KEYS[1], token, 'PX', ARGV[2])
return token
`
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

function redisOptions() {
  return { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1_000, maxRetriesPerRequest: 1, retryStrategy: () => null } as const
}

function safeKeyPart(value: string, label: string): string {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

export class OnlinePokerBotLeaseService {
  private readonly redis: Redis
  private readonly ownsRedis: boolean
  private readonly keyPrefix: string
  private readonly ttlMs: number
  private readonly ownerId: string
  private connecting: Promise<void> | undefined

  constructor(options: OnlinePokerBotLeaseServiceOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? ONLINE_POKER_BOT_LEASE_PREFIX
    this.ttlMs = options.ttlMs ?? ONLINE_POKER_BOT_LEASE_TTL_MS
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 60_000) throw new Error('Bot lease TTL is out of range.')
    this.ownerId = options.ownerId ?? randomUUID()
    if (options.redis) { this.redis = options.redis; this.ownsRedis = false }
    else {
      const url = options.redisUrl ?? process.env.REDIS_URL
      if (!url) throw new Error('REDIS_URL is required for the online poker bot lease.')
      this.redis = new Redis(url, redisOptions())
      this.ownsRedis = true
    }
    if (this.ownsRedis) this.redis.on('error', () => {})
  }

  private key(botKey: string): string { return `${this.keyPrefix}${safeKeyPart(botKey, 'Bot key')}` }
  private fenceKey(botKey: string): string { return `${this.key(botKey)}:fence` }

  private async connect(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined })
        await this.connecting
      } else if (this.redis.status === 'connecting' && this.connecting) await this.connecting
      if (this.redis.status !== 'ready') throw new Error('Redis is not ready.')
    } catch (error) { throw new Error(`Online poker bot coordination is unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }

  async acquire(botKey: string): Promise<OnlinePokerBotLease | null> {
    const key = this.key(botKey)
    await this.connect()
    const token = await this.redis.eval(ACQUIRE_SCRIPT, 2, key, this.fenceKey(botKey), this.ownerId, this.ttlMs) as string | null
    return token ? Object.freeze({ botKey, ownerId: this.ownerId, token, leaseKey: key }) : null
  }

  async renew(lease: OnlinePokerBotLease): Promise<boolean> {
    await this.connect()
    return Number(await this.redis.eval(RENEW_SCRIPT, 1, lease.leaseKey, lease.token, this.ttlMs)) === 1
  }

  async owns(lease: OnlinePokerBotLease): Promise<boolean> {
    await this.connect()
    return await this.redis.get(lease.leaseKey) === lease.token
  }

  async release(lease: OnlinePokerBotLease): Promise<boolean> {
    await this.connect()
    return Number(await this.redis.eval(RELEASE_SCRIPT, 1, lease.leaseKey, lease.token)) === 1
  }

  async disconnect(): Promise<void> { if (this.ownsRedis) this.redis.disconnect() }

  /** Stable key helper for tests and runtime-store fencing. */
  leaseKey(botKey: string): string { return this.key(botKey) }
}
