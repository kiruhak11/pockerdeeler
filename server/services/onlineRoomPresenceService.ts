import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'

export const ONLINE_ROOM_PRESENCE_KEY_PREFIX = 'pocker:online-presence:v1:'
export const ONLINE_ROOM_PRESENCE_TTL_SECONDS = 45
export const ONLINE_ROOM_DISCONNECT_GRACE_SECONDS = 20

const REGISTER_SCRIPT = `
local key = KEYS[1]
local graceKey = KEYS[2]
local fenceKey = KEYS[3]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local indexTtl = tonumber(ARGV[3])
local connectionId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('EXISTS', fenceKey) == 1 then return { -1, 0, '', 1 } end
local before = redis.call('ZCARD', key)
redis.call('ZADD', key, expiresAt, connectionId)
redis.call('EXPIRE', key, indexTtl)
local grace = redis.call('GET', graceKey)
if grace then redis.call('DEL', graceKey) end
return { before, redis.call('ZCARD', key), grace or '' }
`

const REFRESH_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local indexTtl = tonumber(ARGV[3])
local connectionId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZSCORE', key, connectionId) == false then return 0 end
redis.call('ZADD', key, expiresAt, connectionId)
redis.call('EXPIRE', key, indexTtl)
return 1
`

const UNREGISTER_SCRIPT = `
local key = KEYS[1]
local graceKey = KEYS[2]
local now = tonumber(ARGV[1])
local graceDeadline = tonumber(ARGV[2])
local graceTtl = tonumber(ARGV[3])
local connectionId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local removed = redis.call('ZREM', key, connectionId)
local remaining = redis.call('ZCARD', key)
local graceStarted = 0
if removed == 1 and remaining == 0 then
  redis.call('SET', graceKey, tostring(graceDeadline), 'EX', graceTtl)
  graceStarted = 1
end
return { removed, remaining, graceStarted }
`

const START_GRACE_SCRIPT = `
local key = KEYS[1]
local graceKey = KEYS[2]
local now = tonumber(ARGV[1])
local graceDeadline = tonumber(ARGV[2])
local graceTtl = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
local remaining = redis.call('ZCARD', key)
if remaining > 0 or redis.call('EXISTS', graceKey) == 1 then return { 0, remaining } end
redis.call('SET', graceKey, tostring(graceDeadline), 'EX', graceTtl)
return { 1, 0 }
`

const CLAIM_GRACE_SCRIPT = `
local key = KEYS[1]
local graceKey = KEYS[2]
local now = tonumber(ARGV[1])
local token = ARGV[2]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) > 0 then return 0 end
local value = redis.call('GET', graceKey)
if not value then return 0 end
local deadline = tonumber(value)
if not deadline or deadline > now then return 0 end
redis.call('SET', graceKey, 'claim:' .. token, 'EX', 60)
return 1
`

const COMPLETE_GRACE_SCRIPT = `
local graceKey = KEYS[1]
local token = ARGV[1]
if redis.call('GET', graceKey) == 'claim:' .. token then
  return redis.call('DEL', graceKey)
end
return 0
`

const REGISTER_SPECTATOR_SCRIPT = `
local connections = KEYS[1]
local roomSpectators = KEYS[2]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local connectionId = ARGV[4]
local spectatorId = ARGV[5]
redis.call('ZREMRANGEBYSCORE', connections, '-inf', now)
redis.call('ZREMRANGEBYSCORE', roomSpectators, '-inf', now)
redis.call('ZADD', connections, expiresAt, connectionId)
redis.call('ZADD', roomSpectators, expiresAt, spectatorId)
redis.call('EXPIRE', connections, ttl)
redis.call('EXPIRE', roomSpectators, ttl)
return redis.call('ZCARD', roomSpectators)
`

const REFRESH_SPECTATOR_SCRIPT = `
local connections = KEYS[1]
local roomSpectators = KEYS[2]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local connectionId = ARGV[4]
local spectatorId = ARGV[5]
redis.call('ZREMRANGEBYSCORE', connections, '-inf', now)
redis.call('ZREMRANGEBYSCORE', roomSpectators, '-inf', now)
if redis.call('ZSCORE', connections, connectionId) == false then return 0 end
redis.call('ZADD', connections, expiresAt, connectionId)
redis.call('ZADD', roomSpectators, expiresAt, spectatorId)
redis.call('EXPIRE', connections, ttl)
redis.call('EXPIRE', roomSpectators, ttl)
return 1
`

const UNREGISTER_SPECTATOR_SCRIPT = `
local connections = KEYS[1]
local roomSpectators = KEYS[2]
local now = tonumber(ARGV[1])
local connectionId = ARGV[2]
local spectatorId = ARGV[3]
redis.call('ZREMRANGEBYSCORE', connections, '-inf', now)
redis.call('ZREMRANGEBYSCORE', roomSpectators, '-inf', now)
local removed = redis.call('ZREM', connections, connectionId)
local remaining = redis.call('ZCARD', connections)
if remaining == 0 then
  redis.call('DEL', connections)
  redis.call('ZREM', roomSpectators, spectatorId)
else
  local latest = redis.call('ZREVRANGE', connections, 0, 0, 'WITHSCORES')
  if latest[2] then redis.call('ZADD', roomSpectators, latest[2], spectatorId) end
end
return { removed, redis.call('ZCARD', roomSpectators) }
`

const COUNT_SPECTATORS_SCRIPT = `
local roomSpectators = KEYS[1]
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', roomSpectators, '-inf', now)
for index = 2, #ARGV do redis.call('ZREM', roomSpectators, ARGV[index]) end
return redis.call('ZCARD', roomSpectators)
`

const RELEASE_GRACE_SCRIPT = `
local graceKey = KEYS[1]
local token = ARGV[1]
local deadline = ARGV[2]
if redis.call('GET', graceKey) == 'claim:' .. token then
  return redis.call('SET', graceKey, deadline, 'EX', ARGV[3])
end
return 0
`

const ACQUIRE_GRACE_FENCE_SCRIPT = `
local key = KEYS[1]
local graceKey = KEYS[2]
local fenceKey = KEYS[3]
local now = tonumber(ARGV[1])
local token = ARGV[2]
local fenceTtl = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) > 0 then return 0 end
if redis.call('GET', graceKey) ~= 'claim:' .. token then return 0 end
if redis.call('EXISTS', fenceKey) == 1 then return 0 end
redis.call('SET', fenceKey, 'fence:' .. token, 'EX', fenceTtl)
return 1
`

const RELEASE_GRACE_FENCE_SCRIPT = `
local fenceKey = KEYS[1]
local token = ARGV[1]
if redis.call('GET', fenceKey) == 'fence:' .. token then
  return redis.call('DEL', fenceKey)
end
return 0
`

const GRACE_FENCE_TTL_SECONDS = 60
const REGISTER_FENCE_RETRY_ATTEMPTS = 40
const REGISTER_FENCE_RETRY_DELAY_MS = 10

export type OnlineRoomPresenceErrorCode = 'REDIS_UNAVAILABLE' | 'INVALID_ARGUMENT' | 'CONNECTION_NOT_FOUND'

export class OnlineRoomPresenceError extends Error {
  readonly code: OnlineRoomPresenceErrorCode

  constructor(code: OnlineRoomPresenceErrorCode, message: string) {
    super(message)
    this.name = 'OnlineRoomPresenceError'
    this.code = code
  }
}

export type OnlineRoomPresenceRegistration = Readonly<{
  roomId: string
  userId: string
  connectionId: string
}>

export type OnlineRoomSpectatorRegistration = Readonly<{
  roomId: string
  userId: string
  connectionId: string
}>

export type PresenceRegisterResult = Readonly<{
  registration: OnlineRoomPresenceRegistration
  liveConnections: number
  becameConnected: boolean
  cancelledGrace: boolean
}>

export type PresenceUnregisterResult = Readonly<{
  removed: boolean
  liveConnections: number
  graceStarted: boolean
  graceExpiresAt: number | null
}>

export type PresenceClaimResult = Readonly<{
  claimed: boolean
  token: string | null
}>

export type PresenceGraceClaim = Readonly<{
  roomId: string
  userId: string
  token: string
}>

type PresenceOptions = Readonly<{
  redis?: Redis
  redisUrl?: string
  keyPrefix?: string
  ttlSeconds?: number
  graceSeconds?: number
}>

function redisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  } as const
}

function positiveConfig(value: number | undefined, fallback: number, label: string, max: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new OnlineRoomPresenceError('INVALID_ARGUMENT', `${label} must be an integer between 1 and ${max}.`)
  }
  return result
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new OnlineRoomPresenceError('INVALID_ARGUMENT', `${label} must be a bounded non-empty string.`)
  }
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function integerResult(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', `${label} result is invalid.`)
  return result
}

/** Redis-backed connection presence. The local timers only trigger an authoritative Redis check. */
export class OnlineRoomPresenceService {
  private readonly redis: Redis
  private readonly ownsRedis: boolean
  private readonly keyPrefix: string
  private readonly ttlSeconds: number
  private readonly graceSeconds: number
  private connecting: Promise<void> | undefined
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly connectionTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: PresenceOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? ONLINE_ROOM_PRESENCE_KEY_PREFIX
    this.ttlSeconds = positiveConfig(options.ttlSeconds, ONLINE_ROOM_PRESENCE_TTL_SECONDS, 'Presence TTL', 24 * 60 * 60)
    this.graceSeconds = positiveConfig(options.graceSeconds, ONLINE_ROOM_DISCONNECT_GRACE_SECONDS, 'Disconnect grace period', 24 * 60 * 60)
    if (options.redis) {
      this.redis = options.redis
      this.ownsRedis = false
    } else {
      if (!options.redisUrl && !process.env.REDIS_URL) throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', 'REDIS_URL is required for online room presence.')
      this.redis = new Redis(options.redisUrl ?? process.env.REDIS_URL!, redisOptions())
      this.ownsRedis = true
    }
    if (this.ownsRedis) this.redis.on('error', () => {})
  }

  private key(roomId: string, userId: string): string {
    assertId(roomId, 'Room id')
    assertId(userId, 'User id')
    return `${this.keyPrefix}${hashPart(roomId)}:${hashPart(userId)}`
  }

  private graceKey(roomId: string, userId: string): string {
    return `${this.key(roomId, userId)}:grace`
  }

  private fenceKey(roomId: string, userId: string): string {
    return `${this.graceKey(roomId, userId)}:fence`
  }

  private spectatorConnectionsKey(roomId: string, userId: string): string {
    assertId(roomId, 'Room id')
    assertId(userId, 'User id')
    return `${this.keyPrefix}spectator:${hashPart(roomId)}:${hashPart(userId)}`
  }

  private roomSpectatorsKey(roomId: string): string {
    assertId(roomId, 'Room id')
    return `${this.keyPrefix}room-spectators:${hashPart(roomId)}`
  }

  /** Clears only presence artifacts whose keys belong to a room being closed. */
  async clearRoom(roomId: string, includeReleasedFences = false): Promise<number> {
    assertId(roomId, 'Room id')
    const roomHash = hashPart(roomId)
    const patterns = [
      `${this.keyPrefix}${roomHash}:*`,
      `${this.keyPrefix}spectator:${roomHash}:*`,
      `${this.keyPrefix}room-spectators:${roomHash}`
    ]
    let removed = 0
    try {
      await this.connect()
      for (const pattern of patterns) {
        let cursor = '0'
        do {
          const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
          cursor = next
          // A caller may close the room while holding a grace fence. Keep
          // that short lock alive until its owner releases it.
          const scoped = includeReleasedFences ? keys : keys.filter(key => !key.endsWith(':grace:fence'))
          if (scoped.length > 0) removed += await this.redis.del(...scoped)
        } while (cursor !== '0')
      }
      return removed
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Room presence cleanup failed.')
    }
  }

  private spectatorId(userId: string): string {
    return hashPart(userId)
  }

  async registerSpectatorConnection(roomId: string, userId: string): Promise<OnlineRoomSpectatorRegistration> {
    const registration = Object.freeze({ roomId, userId, connectionId: randomUUID() })
    try {
      await this.connect()
      await this.redis.eval(REGISTER_SPECTATOR_SCRIPT, 2,
        this.spectatorConnectionsKey(roomId, userId), this.roomSpectatorsKey(roomId),
        Date.now(), Date.now() + this.ttlSeconds * 1000, this.ttlSeconds + this.graceSeconds + 60,
        registration.connectionId, this.spectatorId(userId))
      return registration
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Spectator registration failed.')
    }
  }

  async refreshSpectatorConnection(registration: OnlineRoomSpectatorRegistration): Promise<void> {
    try {
      await this.connect()
      const refreshed = await this.redis.eval(REFRESH_SPECTATOR_SCRIPT, 2,
        this.spectatorConnectionsKey(registration.roomId, registration.userId), this.roomSpectatorsKey(registration.roomId),
        Date.now(), Date.now() + this.ttlSeconds * 1000, this.ttlSeconds + this.graceSeconds + 60,
        registration.connectionId, this.spectatorId(registration.userId))
      if (integerResult(refreshed, 'Spectator refresh') !== 1) throw new OnlineRoomPresenceError('CONNECTION_NOT_FOUND', 'The spectator connection is no longer registered.')
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Spectator refresh failed.')
    }
  }

  async unregisterSpectatorConnection(registration: OnlineRoomSpectatorRegistration): Promise<{ removed: boolean; spectatorCount: number }> {
    try {
      await this.connect()
      const result = await this.redis.eval(UNREGISTER_SPECTATOR_SCRIPT, 2,
        this.spectatorConnectionsKey(registration.roomId, registration.userId), this.roomSpectatorsKey(registration.roomId),
        Date.now(), registration.connectionId, this.spectatorId(registration.userId)) as unknown[]
      return Object.freeze({ removed: integerResult(result[0], 'Spectator unregister') === 1, spectatorCount: integerResult(result[1], 'Spectator unregister') })
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Spectator unregister failed.')
    }
  }

  async spectatorCount(roomId: string, seatedUserIds: readonly string[] = []): Promise<number> {
    try {
      await this.connect()
      const count = await this.redis.eval(COUNT_SPECTATORS_SCRIPT, 1, this.roomSpectatorsKey(roomId), Date.now(), ...seatedUserIds.map(userId => this.spectatorId(userId)))
      return integerResult(count, 'Spectator count')
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Spectator count failed.')
    }
  }

  keyFor(roomId: string, userId: string): string {
    return this.key(roomId, userId)
  }

  async connect(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined })
        await this.connecting
      } else if (this.redis.status === 'connecting' && this.connecting) {
        await this.connecting
      }
      if (this.redis.status !== 'ready') throw new Error('Redis is not ready.')
    } catch (error) {
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis is unavailable.')
    }
  }

  async disconnect(): Promise<void> {
    for (const timer of this.graceTimers.values()) clearTimeout(timer)
    this.graceTimers.clear()
    for (const timer of this.connectionTimers.values()) clearTimeout(timer)
    this.connectionTimers.clear()
    if (this.ownsRedis) this.redis.disconnect()
  }

  async registerConnection(roomId: string, userId: string): Promise<PresenceRegisterResult> {
    const key = this.key(roomId, userId)
    const graceKey = this.graceKey(roomId, userId)
    const fenceKey = this.fenceKey(roomId, userId)
    const connectionId = randomUUID()
    try {
      await this.connect()
      for (let attempt = 0; attempt < REGISTER_FENCE_RETRY_ATTEMPTS; attempt += 1) {
        const now = Date.now()
        const result = await this.redis.eval(REGISTER_SCRIPT, 3, key, graceKey, fenceKey, now, now + this.ttlSeconds * 1000, this.ttlSeconds + this.graceSeconds + 60, connectionId) as unknown[]
        const status = Number(result[0])
        if (status === -1) {
          await new Promise(resolve => setTimeout(resolve, REGISTER_FENCE_RETRY_DELAY_MS))
          continue
        }
        const before = integerResult(status, 'Presence register')
        const liveConnections = integerResult(result[1], 'Presence register')
        return Object.freeze({
          registration: Object.freeze({ roomId, userId, connectionId }),
          liveConnections,
          becameConnected: before === 0,
          cancelledGrace: typeof result[2] === 'string' && (result[2] as string).length > 0
        })
      }
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', 'Presence registration is fenced by an active disconnect transition.')
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Presence registration failed.')
    }
  }

  async refreshConnection(registration: OnlineRoomPresenceRegistration): Promise<void> {
    const key = this.key(registration.roomId, registration.userId)
    try {
      await this.connect()
      const refreshed = await this.redis.eval(REFRESH_SCRIPT, 1, key, Date.now(), Date.now() + this.ttlSeconds * 1000, this.ttlSeconds + this.graceSeconds + 60, registration.connectionId)
      if (integerResult(refreshed, 'Presence refresh') !== 1) throw new OnlineRoomPresenceError('CONNECTION_NOT_FOUND', 'The WebSocket presence connection is no longer registered.')
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Presence refresh failed.')
    }
  }

  async unregisterConnection(registration: OnlineRoomPresenceRegistration): Promise<PresenceUnregisterResult> {
    this.clearConnectionExpiry(registration)
    const key = this.key(registration.roomId, registration.userId)
    const graceKey = this.graceKey(registration.roomId, registration.userId)
    const now = Date.now()
    const graceExpiresAt = now + this.graceSeconds * 1000
    try {
      await this.connect()
      const result = await this.redis.eval(UNREGISTER_SCRIPT, 2, key, graceKey, now, graceExpiresAt, this.graceSeconds + 60, registration.connectionId) as unknown[]
      const removed = integerResult(result[0], 'Presence unregister') === 1
      const liveConnections = integerResult(result[1], 'Presence unregister')
      const graceStarted = integerResult(result[2], 'Presence unregister') === 1
      return Object.freeze({ removed, liveConnections, graceStarted, graceExpiresAt: graceStarted ? graceExpiresAt : null })
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Presence unregister failed.')
    }
  }

  async startGraceIfEmpty(roomId: string, userId: string, now = Date.now()): Promise<PresenceUnregisterResult> {
    const key = this.key(roomId, userId)
    const graceKey = this.graceKey(roomId, userId)
    const graceExpiresAt = now + this.graceSeconds * 1000
    try {
      await this.connect()
      const result = await this.redis.eval(START_GRACE_SCRIPT, 2, key, graceKey, now, graceExpiresAt, this.graceSeconds + 60) as unknown[]
      const graceStarted = integerResult(result[0], 'Grace start') === 1
      const liveConnections = integerResult(result[1], 'Grace start')
      return Object.freeze({ removed: false, liveConnections, graceStarted, graceExpiresAt: graceStarted ? graceExpiresAt : null })
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace start failed.')
    }
  }

  async liveConnectionCount(roomId: string, userId: string): Promise<number> {
    const key = this.key(roomId, userId)
    try {
      await this.connect()
      await this.redis.zremrangebyscore(key, '-inf', Date.now())
      return integerResult(await this.redis.zcard(key), 'Presence count')
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Presence count failed.')
    }
  }

  async claimExpiredGrace(roomId: string, userId: string, now = Date.now()): Promise<PresenceClaimResult> {
    const key = this.key(roomId, userId)
    const graceKey = this.graceKey(roomId, userId)
    const token = randomUUID()
    try {
      await this.connect()
      const claimed = await this.redis.eval(CLAIM_GRACE_SCRIPT, 2, key, graceKey, now, token)
      return Object.freeze({ claimed: integerResult(claimed, 'Grace claim') === 1, token })
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace claim failed.')
    }
  }

  async completeGraceDisconnect(roomId: string, userId: string, token: string): Promise<void> {
    assertId(token, 'Grace token')
    try {
      await this.connect()
      await this.redis.eval(COMPLETE_GRACE_SCRIPT, 1, this.graceKey(roomId, userId), token)
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace completion failed.')
    }
  }

  async releaseGrace(roomId: string, userId: string, token: string, deadline = Date.now() + this.graceSeconds * 1000): Promise<void> {
    assertId(token, 'Grace token')
    try {
      await this.connect()
      await this.redis.eval(RELEASE_GRACE_SCRIPT, 1, this.graceKey(roomId, userId), token, deadline, this.graceSeconds + 60)
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace release failed.')
    }
  }

  /**
   * Holds a Redis fence while the authoritative room CAS performs a grace
   * disconnect. A concurrent register is retried until this short transition
   * finishes, so it cannot invalidate the claim between validation and CAS.
   */
  async withGraceClaim<T>(claim: PresenceGraceClaim, callback: () => Promise<T>): Promise<T | null> {
    assertId(claim.roomId, 'Room id')
    assertId(claim.userId, 'User id')
    assertId(claim.token, 'Grace token')
    const key = this.key(claim.roomId, claim.userId)
    const graceKey = this.graceKey(claim.roomId, claim.userId)
    const fenceKey = this.fenceKey(claim.roomId, claim.userId)
    try {
      await this.connect()
      const acquired = integerResult(await this.redis.eval(
        ACQUIRE_GRACE_FENCE_SCRIPT,
        3,
        key,
        graceKey,
        fenceKey,
        Date.now(),
        claim.token,
        GRACE_FENCE_TTL_SECONDS
      ), 'Grace fence acquisition')
      if (acquired !== 1) return null
    } catch (error) {
      if (error instanceof OnlineRoomPresenceError) throw error
      throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace fence failed.')
    }

    try {
      return await callback()
    } finally {
      try {
        await this.redis.eval(RELEASE_GRACE_FENCE_SCRIPT, 1, fenceKey, claim.token)
      } catch (error) {
        if (error instanceof OnlineRoomPresenceError) throw error
        throw new OnlineRoomPresenceError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Grace fence release failed.')
      }
    }
  }

  private connectionTimerKey(registration: OnlineRoomPresenceRegistration): string {
    return `${registration.roomId}:${registration.userId}:${registration.connectionId}`
  }

  private clearConnectionExpiry(registration: OnlineRoomPresenceRegistration): void {
    const timerKey = this.connectionTimerKey(registration)
    const timer = this.connectionTimers.get(timerKey)
    if (timer) clearTimeout(timer)
    this.connectionTimers.delete(timerKey)
  }

  /** Checks lease expiry through Redis and starts the normal grace lifecycle. */
  scheduleConnectionExpiry(registration: OnlineRoomPresenceRegistration, onExpired: () => Promise<void>): void {
    this.clearConnectionExpiry(registration)
    const timerKey = this.connectionTimerKey(registration)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const liveConnections = await this.liveConnectionCount(registration.roomId, registration.userId)
          if (liveConnections > 0) {
            this.scheduleConnectionExpiry(registration, onExpired)
            return
          }
          const grace = await this.startGraceIfEmpty(registration.roomId, registration.userId)
          if (grace.graceStarted) await onExpired()
        } catch {
          this.scheduleConnectionExpiry(registration, onExpired)
        } finally {
          if (this.connectionTimers.get(timerKey) === timer) this.connectionTimers.delete(timerKey)
        }
      })()
    }, this.ttlSeconds * 1000 + 50)
    timer.unref?.()
    this.connectionTimers.set(timerKey, timer)
  }

  scheduleGraceExpiry(roomId: string, userId: string, callback: (claimToken: string) => Promise<void>): void {
    const timerKey = `${roomId}:${userId}`
    const previous = this.graceTimers.get(timerKey)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const claim = await this.claimExpiredGrace(roomId, userId)
          if (!claim.claimed || !claim.token) return
          try {
            const fenced = await this.withGraceClaim({ roomId, userId, token: claim.token }, () => callback(claim.token!))
            if (fenced === null) return
            await this.completeGraceDisconnect(roomId, userId, claim.token)
          } catch (error) {
            await this.releaseGrace(roomId, userId, claim.token).catch(() => undefined)
            const statusCode = (error as { statusCode?: number } | null)?.statusCode
            if (statusCode !== 404 && statusCode !== 410) {
              this.scheduleGraceExpiry(roomId, userId, callback)
            }
          }
        } catch {
          // The next socket lifecycle operation can retry the authoritative check.
        } finally {
          if (this.graceTimers.get(timerKey) === timer) this.graceTimers.delete(timerKey)
        }
      })()
    }, this.graceSeconds * 1000 + 50)
    timer.unref?.()
    this.graceTimers.set(timerKey, timer)
  }
}

let defaultPresence: OnlineRoomPresenceService | undefined

export function getOnlineRoomPresenceService(): OnlineRoomPresenceService {
  return (defaultPresence ??= new OnlineRoomPresenceService())
}
