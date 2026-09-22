import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import type { HandStreet } from '../utils/pokerHandState'

export const ONLINE_ROOM_TURN_TIMEOUT_MS = 30_000
export const ONLINE_ROOM_TURN_TIMER_KEY_PREFIX = 'pocker:online-turn-timer:v1:'
export const ONLINE_ROOM_TURN_TIMER_POLL_MS = 250
const ONLINE_ROOM_TURN_TIMER_JOB_TTL_SECONDS = 7 * 24 * 60 * 60
const ONLINE_ROOM_TURN_TIMER_CLAIM_TTL_SECONDS = 60

export type OnlineRoomTurnTimerJob = Readonly<{
  jobId: string
  roomId: string
  roomCode: string
  playerId: string
  expectedTableStateVersion: number
  handId: string
  street: HandStreet
  deadlineAt: number
  /** Runtime CAS revision used to prevent an older completion from replacing a newer job. */
  runtimeRevision?: number
}>

export type OnlineRoomTurnTimerProcessResult = 'COMPLETED' | 'STALE' | 'RETRY'
export type OnlineRoomTurnTimerProcessor = (job: OnlineRoomTurnTimerJob) => Promise<OnlineRoomTurnTimerProcessResult>

export type OnlineRoomTurnTimerServiceOptions = Readonly<{
  redisUrl?: string
  redis?: Redis
  keyPrefix?: string
  pollIntervalMs?: number
}>

export type OnlineRoomTurnTimerErrorCode = 'REDIS_UNAVAILABLE' | 'INVALID_ARGUMENT' | 'CORRUPTED_JOB'

export class OnlineRoomTurnTimerError extends Error {
  readonly code: OnlineRoomTurnTimerErrorCode

  constructor(code: OnlineRoomTurnTimerErrorCode, message: string) {
    super(message)
    this.name = 'OnlineRoomTurnTimerError'
    this.code = code
  }
}

type JsonRecord = Record<string, unknown>

const SCHEDULE_SCRIPT = `
local indexKey = KEYS[1]
local currentKey = KEYS[2]
local jobKey = KEYS[3]
local claimPrefix = ARGV[1]
local jobId = ARGV[2]
local deadline = tonumber(ARGV[3])
local payload = ARGV[4]
local jobTtl = tonumber(ARGV[5])
local old = redis.call('GET', currentKey)
if old and old ~= jobId then
  local oldPayload = redis.call('GET', string.sub(jobKey, 1, string.len(jobKey) - string.len(jobId)) .. old)
  local oldRevision = oldPayload and tonumber(string.match(oldPayload, '"runtimeRevision":([0-9]+)')) or nil
  local newRevision = tonumber(ARGV[6]) or 0
  if oldRevision and newRevision > 0 and oldRevision > newRevision then return 0 end
  redis.call('ZREM', indexKey, old)
  redis.call('DEL', claimPrefix .. old)
  redis.call('DEL', string.sub(jobKey, 1, string.len(jobKey) - string.len(jobId)) .. old)
end
redis.call('ZADD', indexKey, deadline, jobId)
redis.call('SET', jobKey, payload, 'EX', jobTtl)
redis.call('SET', currentKey, jobId, 'EX', jobTtl)
return 1
`

const CLEAR_SCRIPT = `
local indexKey = KEYS[1]
local currentKey = KEYS[2]
local jobPrefix = ARGV[1]
local claimPrefix = ARGV[2]
local old = redis.call('GET', currentKey)
if old then
  redis.call('ZREM', indexKey, old)
  redis.call('DEL', jobPrefix .. old)
  redis.call('DEL', claimPrefix .. old)
  redis.call('DEL', currentKey)
end
return 1
`

const CLAIM_DUE_SCRIPT = `
local indexKey = KEYS[1]
local jobPrefix = ARGV[1]
local claimPrefix = ARGV[2]
local now = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local ids = redis.call('ZRANGEBYSCORE', indexKey, '-inf', now, 'LIMIT', 0, limit)
local payloads = {}
for _, id in ipairs(ids) do
  if redis.call('ZREM', indexKey, id) == 1 then
    local payload = redis.call('GET', jobPrefix .. id)
    if payload then
      redis.call('SET', claimPrefix .. id, payload, 'EX', ${ONLINE_ROOM_TURN_TIMER_CLAIM_TTL_SECONDS})
      table.insert(payloads, payload)
    end
  end
end
return payloads
`

const COMPLETE_SCRIPT = `
local currentKey = KEYS[1]
local jobKey = KEYS[2]
local claimKey = KEYS[3]
local jobId = ARGV[1]
if redis.call('GET', currentKey) == jobId then redis.call('DEL', currentKey) end
redis.call('DEL', jobKey)
redis.call('DEL', claimKey)
return 1
`

const RELEASE_SCRIPT = `
local indexKey = KEYS[1]
local jobKey = KEYS[2]
local claimKey = KEYS[3]
local jobId = ARGV[1]
local deadline = tonumber(ARGV[2])
if redis.call('EXISTS', claimKey) == 1 then
  redis.call('ZADD', indexKey, deadline, jobId)
  redis.call('DEL', claimKey)
  return 1
end
return 0
`

function redisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  } as const
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', `${label} must be a bounded non-empty string.`)
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseJob(payload: string): OnlineRoomTurnTimerJob {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new OnlineRoomTurnTimerError('CORRUPTED_JOB', 'Turn timer payload is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OnlineRoomTurnTimerError('CORRUPTED_JOB', 'Turn timer payload must be an object.')
  }
  const raw = value as JsonRecord
  const streets: readonly HandStreet[] = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'FINISHED']
  if (typeof raw.jobId !== 'string' || typeof raw.roomId !== 'string' || typeof raw.roomCode !== 'string' ||
      typeof raw.playerId !== 'string' || typeof raw.handId !== 'string' || !streets.includes(raw.street as HandStreet) ||
      !Number.isSafeInteger(raw.expectedTableStateVersion) || (raw.expectedTableStateVersion as number) < 0 ||
      !Number.isSafeInteger(raw.deadlineAt) || (raw.deadlineAt as number) <= 0 ||
      (raw.runtimeRevision !== undefined && (!Number.isSafeInteger(raw.runtimeRevision) || (raw.runtimeRevision as number) < 1))) {
    throw new OnlineRoomTurnTimerError('CORRUPTED_JOB', 'Turn timer payload is invalid.')
  }
  return Object.freeze({
    jobId: raw.jobId,
    roomId: raw.roomId,
    roomCode: raw.roomCode,
    playerId: raw.playerId,
    expectedTableStateVersion: raw.expectedTableStateVersion as number,
    handId: raw.handId,
    street: raw.street as HandStreet,
    deadlineAt: raw.deadlineAt as number,
    ...(raw.runtimeRevision === undefined ? {} : { runtimeRevision: raw.runtimeRevision as number })
  })
}

function validPollInterval(value: number | undefined): number {
  const interval = value ?? ONLINE_ROOM_TURN_TIMER_POLL_MS
  if (!Number.isSafeInteger(interval) || interval < 50 || interval > 60_000) {
    throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Turn timer poll interval is invalid.')
  }
  return interval
}

/** Redis-backed shared turn deadlines. Local polling is only a worker trigger; Redis owns jobs and claims. */
export class OnlineRoomTurnTimerService {
  private readonly redis: Redis
  private readonly ownsRedis: boolean
  private readonly keyPrefix: string
  private readonly pollIntervalMs: number
  private connecting: Promise<void> | undefined
  private workerTimer: ReturnType<typeof setInterval> | undefined
  private processor: OnlineRoomTurnTimerProcessor | undefined
  private processing = false

  constructor(options: OnlineRoomTurnTimerServiceOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? ONLINE_ROOM_TURN_TIMER_KEY_PREFIX
    this.pollIntervalMs = validPollInterval(options.pollIntervalMs)
    if (options.redis) {
      this.redis = options.redis
      this.ownsRedis = false
    } else {
      if (!options.redisUrl && !process.env.REDIS_URL) {
        throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', 'REDIS_URL is required for online turn timers.')
      }
      this.redis = new Redis(options.redisUrl ?? process.env.REDIS_URL!, redisOptions())
      this.ownsRedis = true
    }
    if (this.ownsRedis) this.redis.on('error', () => {})
  }

  private indexKey(): string {
    return `${this.keyPrefix}index`
  }

  private roomKey(roomId: string): string {
    assertId(roomId, 'Room id')
    return `${this.keyPrefix}room:${hash(roomId)}`
  }

  private jobPrefix(): string {
    return `${this.keyPrefix}job:`
  }

  private claimPrefix(): string {
    return `${this.keyPrefix}claim:`
  }

  private jobKey(jobId: string): string {
    assertId(jobId, 'Job id')
    return `${this.jobPrefix()}${jobId}`
  }

  private claimKey(jobId: string): string {
    assertId(jobId, 'Job id')
    return `${this.claimPrefix()}${jobId}`
  }

  private async connect(): Promise<void> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined })
        await this.connecting
      } else if (this.redis.status === 'connecting' && this.connecting) {
        await this.connecting
      }
      if (this.redis.status !== 'ready') throw new Error('Redis is not ready.')
    } catch (error) {
      throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Redis is unavailable.')
    }
  }

  private validateJob(job: Omit<OnlineRoomTurnTimerJob, 'jobId'>): void {
    assertId(job.roomId, 'Room id')
    assertId(job.roomCode, 'Room code')
    assertId(job.playerId, 'Player id')
    assertId(job.handId, 'Hand id')
    if (!Number.isSafeInteger(job.expectedTableStateVersion) || job.expectedTableStateVersion < 0) throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Expected table state version is invalid.')
    if (!Number.isSafeInteger(job.deadlineAt) || job.deadlineAt <= 0) throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Turn deadline is invalid.')
    if (!['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(job.street)) throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Turn timer street is invalid.')
    if (job.runtimeRevision !== undefined && (!Number.isSafeInteger(job.runtimeRevision) || job.runtimeRevision < 1)) throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Runtime revision is invalid.')
  }

  async schedule(job: Omit<OnlineRoomTurnTimerJob, 'jobId'>): Promise<OnlineRoomTurnTimerJob | null> {
    this.validateJob(job)
    const complete = Object.freeze({ ...job, jobId: randomUUID() })
    const payload = JSON.stringify(complete)
    try {
      await this.connect()
      const result = await this.redis.eval(
        SCHEDULE_SCRIPT,
        3,
        this.indexKey(),
        this.roomKey(job.roomId),
        this.jobKey(complete.jobId),
        this.claimPrefix(),
        complete.jobId,
        complete.deadlineAt,
        payload,
        ONLINE_ROOM_TURN_TIMER_JOB_TTL_SECONDS,
        complete.runtimeRevision ?? 0
      )
      return Number(result) === 1 ? complete : null
    } catch (error) {
      if (error instanceof OnlineRoomTurnTimerError) throw error
      throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Turn timer scheduling failed.')
    }
  }

  async clear(roomId: string): Promise<void> {
    assertId(roomId, 'Room id')
    try {
      await this.connect()
      await this.redis.eval(CLEAR_SCRIPT, 2, this.indexKey(), this.roomKey(roomId), this.jobPrefix(), this.claimPrefix())
    } catch (error) {
      if (error instanceof OnlineRoomTurnTimerError) throw error
      throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Turn timer cleanup failed.')
    }
  }

  async processDue(processor: OnlineRoomTurnTimerProcessor, now = Date.now(), limit = 32): Promise<number> {
    if (typeof processor !== 'function') throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'A timer processor is required.')
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new OnlineRoomTurnTimerError('INVALID_ARGUMENT', 'Timer processing arguments are invalid.')
    }
    let payloads: unknown
    try {
      await this.connect()
      payloads = await this.redis.eval(CLAIM_DUE_SCRIPT, 1, this.indexKey(), this.jobPrefix(), this.claimPrefix(), now, limit)
    } catch (error) {
      if (error instanceof OnlineRoomTurnTimerError) throw error
      throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', error instanceof Error ? error.message : 'Turn timer polling failed.')
    }
    if (!Array.isArray(payloads)) throw new OnlineRoomTurnTimerError('REDIS_UNAVAILABLE', 'Turn timer claim result is invalid.')
    let processed = 0
    for (const raw of payloads) {
      let job: OnlineRoomTurnTimerJob
      try {
        job = parseJob(String(raw))
      } catch {
        continue
      }
      let result: OnlineRoomTurnTimerProcessResult = 'RETRY'
      try {
        result = await processor(job)
      } catch {
        result = 'RETRY'
      }
      if (result === 'RETRY') {
        await this.release(job).catch(() => undefined)
      } else {
        await this.complete(job).catch(() => undefined)
      }
      processed += 1
    }
    return processed
  }

  start(processor: OnlineRoomTurnTimerProcessor): void {
    this.processor = processor
    if (this.workerTimer) return
    const tick = () => {
      if (this.processing || !this.processor) return
      this.processing = true
      void this.processDue(this.processor).catch(() => undefined).finally(() => { this.processing = false })
    }
    this.workerTimer = setInterval(tick, this.pollIntervalMs)
    this.workerTimer.unref?.()
    tick()
  }

  stop(): void {
    if (this.workerTimer) clearInterval(this.workerTimer)
    this.workerTimer = undefined
    this.processor = undefined
    this.processing = false
  }

  async disconnect(): Promise<void> {
    this.stop()
    if (this.ownsRedis) this.redis.disconnect()
  }

  private async complete(job: OnlineRoomTurnTimerJob): Promise<void> {
    await this.connect()
    await this.redis.eval(COMPLETE_SCRIPT, 3, this.roomKey(job.roomId), this.jobKey(job.jobId), this.claimKey(job.jobId), job.jobId)
  }

  private async release(job: OnlineRoomTurnTimerJob): Promise<void> {
    await this.connect()
    await this.redis.eval(RELEASE_SCRIPT, 3, this.indexKey(), this.jobKey(job.jobId), this.claimKey(job.jobId), job.jobId, job.deadlineAt)
  }
}

let defaultTimer: OnlineRoomTurnTimerService | undefined

export function getOnlineRoomTurnTimerService(): OnlineRoomTurnTimerService {
  return (defaultTimer ??= new OnlineRoomTurnTimerService())
}
