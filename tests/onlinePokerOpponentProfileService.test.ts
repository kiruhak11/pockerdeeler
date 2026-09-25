import test from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import { ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS, OnlinePokerOpponentProfileService } from '../server/services/onlinePokerOpponentProfileService'

function fakeRedis() {
  const rows = new Map<string, Array<{ member: string; score: number }>>()
  const redis = {
    status: 'ready',
    on() {},
    multi() {
      const commands: Array<() => void> = []
      const pipeline = {
        zadd(key: string, score: number, member: string) { commands.push(() => rows.set(key, [...(rows.get(key) ?? []), { member, score }])); return pipeline },
        zremrangebyscore(key: string, min: string, max: number) { commands.push(() => rows.set(key, (rows.get(key) ?? []).filter(item => item.score > max))); return pipeline },
        expire() { return pipeline },
        async exec() { commands.forEach(command => command()); return [] }
      }
      return pipeline
    },
    async zrangebyscore(key: string, min: number, max: string) {
      const earliest = Number(min)
      return (rows.get(key) ?? []).filter(item => item.score >= earliest).sort((a, b) => a.score - b.score).map(item => item.member)
    }
  }
  return redis as unknown as Redis
}

test('opponent profiles use recent public actions only and expire beyond the rolling window', async () => {
  const service = new OnlinePokerOpponentProfileService({ redis: fakeRedis() })
  const now = 1_000_000
  await service.recordPublicAction('opponent-id', 'all-in', now)
  await service.recordPublicAction('opponent-id', 'fold', now + 1)
  await service.recordPublicAction('opponent-id', 'raise', now + 2)
  const recent = await service.getProfile('opponent-id', now + 3)
  assert.deepEqual(recent, { allInFrequency: 1 / 3, raiseFrequency: 1 / 3, foldFrequency: 1 / 3, sampleSize: 3 })
  const expired = await service.getProfile('opponent-id', now + ONLINE_POKER_OPPONENT_PROFILE_WINDOW_MS + 10)
  assert.deepEqual(expired, { allInFrequency: 0, raiseFrequency: 0, foldFrequency: 0, sampleSize: 0 })
})
