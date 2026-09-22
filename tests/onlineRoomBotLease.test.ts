import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { OnlinePokerBotLeaseService } from '../server/services/onlinePokerBotLeaseService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { createOnlineRoom } from '../server/utils/pokerOnlineRoom'

class MemoryLeaseRedis {
  status = 'ready'
  values = new Map<string, string>()
  counters = new Map<string, number>()
  async eval(script: string, keyCount: number, ...args: Array<string | number>) {
    const keys = args.slice(0, keyCount).map(String)
    const argv = args.slice(keyCount).map(String)
    if (script.includes("redis.call('INCR'")) {
      if (this.values.has(keys[0]!)) return null
      const next = (this.counters.get(keys[1]!) ?? 0) + 1
      this.counters.set(keys[1]!, next)
      const token = `${next}:${argv[0]}`
      this.values.set(keys[0]!, token)
      return token
    }
    if (script.includes('PEXPIRE')) return this.values.get(keys[0]!) === argv[0] ? 1 : 0
    if (script.includes("redis.call('DEL'")) {
      if (this.values.get(keys[0]!) !== argv[0]) return 0
      this.values.delete(keys[0]!)
      return 1
    }
    throw new Error('Unknown test lease script.')
  }
  async get(key: string) { return this.values.get(key) ?? null }
}

test('bot identity lease excludes a second worker and fences stale renew/release after recovery', async () => {
  const redis = new MemoryLeaseRedis()
  const first = new OnlinePokerBotLeaseService({ redis: redis as any, ownerId: 'instance-a', keyPrefix: 'test:bot:', ttlMs: 5_000 })
  const second = new OnlinePokerBotLeaseService({ redis: redis as any, ownerId: 'instance-b', keyPrefix: 'test:bot:', ttlMs: 5_000 })
  const oldLease = await first.acquire('online-bot-01')
  assert.ok(oldLease)
  assert.equal(await second.acquire('online-bot-01'), null)
  redis.values.delete(oldLease.leaseKey) // represents lease TTL expiry after worker crash
  const recovered = await second.acquire('online-bot-01')
  assert.ok(recovered)
  assert.notEqual(recovered.token, oldLease.token)
  assert.equal(await first.renew(oldLease), false)
  assert.equal(await first.release(oldLease), false)
  assert.equal(await second.owns(recovered), true)
})

const sourceRedisUrl = process.env.ONLINE_POKER_BOT_TEST_REDIS_URL ?? process.env.ONLINE_ROOM_TEST_REDIS_URL ?? process.env.REDIS_URL
const botRedisUrl = sourceRedisUrl?.replace(/\/(\d+)$/, (_match, index: string) => `/${Number(index) + 1}`)

test('runtime CAS rejects a stale bot fence atomically when Redis is available', { skip: !botRedisUrl }, async () => {
  const redis = new Redis(botRedisUrl!, { lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null })
  const prefix = `test:bot-fence:${randomUUID()}:`
  const store = new OnlineRoomRuntimeStore({ redis, redisUrl: botRedisUrl!, keyPrefix: prefix })
  const leaseKey = `${prefix}lease:online-bot-01`
  const roomId = randomUUID()
  const room = createOnlineRoom({ roomId, roomCode: 'AB2345', ownerId: 'test-bot', ownerStack: 100, smallBlind: 1, bigBlind: 2 })
  try {
    await redis.connect()
    await redis.set(leaseKey, 'fence:old', 'PX', 10_000)
    const created = await store.create(room, { key: leaseKey, token: 'fence:old' })
    const changed = await store.update(roomId, created.runtimeRevision, state => Object.freeze({ ...state, roomVersion: state.roomVersion + 1 }), { key: leaseKey, token: 'fence:old' })
    assert.equal(changed.runtimeRevision, 2)
    await redis.set(leaseKey, 'fence:new', 'PX', 10_000)
    await assert.rejects(
      store.update(roomId, changed.runtimeRevision, state => Object.freeze({ ...state, roomVersion: state.roomVersion + 1 }), { key: leaseKey, token: 'fence:old' }),
      /lease is no longer valid|stale/i
    )
    const current = await store.get(roomId)
    assert.equal(current?.runtimeRevision, 2)
    assert.equal(current?.state.roomVersion, changed.state.roomVersion)
  } finally {
    await redis.del(store.keyFor(roomId), leaseKey)
    await store.disconnect()
    redis.disconnect()
  }
})
