import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import type { BettingActionType } from '../utils/pokerBetting'

export const ONLINE_POKER_OPPONENT_PROFILE_PREFIX = 'pocker:online-opponent-profile:v1:'
export const ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS = 30 * 60_000
const ACTIONS = new Set<BettingActionType>(['fold', 'check', 'call', 'bet', 'raise', 'all-in'])

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

export type OpponentActionProfile = Readonly<{ allInFrequency: number; raiseFrequency: number; foldFrequency: number; sampleSize: number }>

/** Stores only publicly observed actions; the rolling profile contains no card or deck data. */
export class OnlinePokerOpponentProfileService {
  private readonly redis: Redis
  private readonly ownsRedis: boolean

  constructor(options: { redis?: Redis; redisUrl?: string; keyPrefix?: string } = {}) {
    this.keyPrefix = options.keyPrefix ?? ONLINE_POKER_OPPONENT_PROFILE_PREFIX
    const url = options.redisUrl ?? process.env.REDIS_URL
    if (!options.redis && !url) throw new Error('REDIS_URL is required for opponent profiles.')
    this.redis = options.redis ?? new Redis(url!, { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1_000, maxRetriesPerRequest: 1, retryStrategy: () => null })
    this.ownsRedis = !options.redis
    if (this.ownsRedis) this.redis.on('error', () => {})
  }

  private readonly keyPrefix: string
  private key(userId: string): string { return `${this.keyPrefix}${hash(userId)}` }

  private async ready(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect()
    if (this.redis.status !== 'ready') throw new Error('Opponent profile Redis is unavailable.')
  }

  async recordPublicAction(userId: string, action: BettingActionType, now = Date.now()): Promise<void> {
    if (!userId || !ACTIONS.has(action) || !Number.isSafeInteger(now)) return
    await this.ready()
    const key = this.key(userId)
    const pipeline = this.redis.multi()
    pipeline.zadd(key, now, `${now}:${randomUUID()}:${action}`)
    pipeline.zremrangebyscore(key, '-inf', now - ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS)
    pipeline.expire(key, Math.ceil(ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS / 1_000))
    await pipeline.exec()
  }

  async getProfile(userId: string, now = Date.now()): Promise<OpponentActionProfile> {
    await this.ready()
    const events = await this.redis.zrangebyscore(this.key(userId), now - ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS, '+inf')
    let allIns = 0
    let raises = 0
    let folds = 0
    for (const event of events) {
      const action = event.slice(event.lastIndexOf(':') + 1)
      if (action === 'all-in') allIns += 1
      if (action === 'raise' || action === 'bet') raises += 1
      if (action === 'fold') folds += 1
    }
    const sampleSize = events.length
    return Object.freeze({ allInFrequency: sampleSize ? allIns / sampleSize : 0, raiseFrequency: sampleSize ? raises / sampleSize : 0, foldFrequency: sampleSize ? folds / sampleSize : 0, sampleSize })
  }

  async disconnect(): Promise<void> { if (this.ownsRedis) await this.redis.quit().catch(() => this.redis.disconnect()) }
}

let shared: OnlinePokerOpponentProfileService | undefined
export function getOnlinePokerOpponentProfileService(): OnlinePokerOpponentProfileService {
  shared ??= new OnlinePokerOpponentProfileService()
  return shared
}
