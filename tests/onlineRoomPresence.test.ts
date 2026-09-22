import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'
import {
  OnlineRoomPresenceError,
  OnlineRoomPresenceService
} from '../server/services/onlineRoomPresenceService'
import {
  createAuthenticatedOnlineRoom,
  joinAuthenticatedOnlineRoom,
  setAuthenticatedOnlineRoomPresence,
  setAuthenticatedOnlineRoomReady
} from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { startOnlineRoomHand } from '../server/utils/pokerOnlineRoom'
import { createStandardDeck } from '../server/utils/pokerDeck'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const redisIsolated = Boolean(redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const isolated = Boolean(dbUrl && redisIsolated)
const redis = redisIsolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const db = new PrismaClient()
const roomIds: string[] = []
const prefixes: string[] = []

function presence(): OnlineRoomPresenceService {
  const keyPrefix = `pocker:test:presence:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomPresenceService({ redis: redis!, keyPrefix, ttlSeconds: 2, graceSeconds: 1 })
}

function runtime(): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:presence-runtime:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 60 })
}

test.before(async () => {
  if (redisIsolated) await redis!.connect()
})

test.after(async () => {
  if (redisIsolated) {
    for (const prefix of prefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length > 0) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
  if (dbUrl && roomIds.length > 0) {
    await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: roomIds } } })
    await db.onlineRoom.deleteMany({ where: { id: { in: roomIds } } })
  }
  await db.$disconnect()
})

test('server generates a connection id and first socket becomes connected', { skip: !redisIsolated }, async () => {
  const service = presence()
  const first = await service.registerConnection('room-1', 'user-1')
  assert.match(first.registration.connectionId, /^[0-9a-f-]{36}$/)
  assert.equal(first.liveConnections, 1)
  assert.equal(first.becameConnected, true)
  assert.equal(await service.liveConnectionCount('room-1', 'user-1'), 1)
  await service.disconnect()
})

test('multiple sockets share one logical connected presence', { skip: !redisIsolated }, async () => {
  const service = presence()
  const first = await service.registerConnection('room-2', 'user-2')
  const second = await service.registerConnection('room-2', 'user-2')
  assert.equal(second.liveConnections, 2)
  const one = await service.unregisterConnection(first.registration)
  assert.equal(one.removed, true)
  assert.equal(one.liveConnections, 1)
  assert.equal(one.graceStarted, false)
  const last = await service.unregisterConnection(second.registration)
  assert.equal(last.removed, true)
  assert.equal(last.liveConnections, 0)
  assert.equal(last.graceStarted, true)
  await service.disconnect()
})

test('reconnect during grace cancels the pending disconnect', { skip: !redisIsolated }, async () => {
  const service = presence()
  const first = await service.registerConnection('room-3', 'user-3')
  const closed = await service.unregisterConnection(first.registration)
  assert.equal(closed.graceStarted, true)
  const reconnect = await service.registerConnection('room-3', 'user-3')
  assert.equal(reconnect.cancelledGrace, true)
  const claim = await service.claimExpiredGrace('room-3', 'user-3', closed.graceExpiresAt! + 1)
  assert.equal(claim.claimed, false)
  assert.equal(await service.liveConnectionCount('room-3', 'user-3'), 1)
  await service.disconnect()
})

test('expired grace can be claimed only when no connection remains', { skip: !redisIsolated }, async () => {
  const service = presence()
  const first = await service.registerConnection('room-4', 'user-4')
  const closed = await service.unregisterConnection(first.registration)
  const claim = await service.claimExpiredGrace('room-4', 'user-4', closed.graceExpiresAt! + 1)
  assert.equal(claim.claimed, true)
  assert.ok(claim.token)
  await service.completeGraceDisconnect('room-4', 'user-4', claim.token!)
  const secondClaim = await service.claimExpiredGrace('room-4', 'user-4', closed.graceExpiresAt! + 2)
  assert.equal(secondClaim.claimed, false)
  await service.disconnect()
})

test('cross-instance services observe one shared connection set', { skip: !redisIsolated }, async () => {
  const keyPrefix = `pocker:test:presence-shared:${randomUUID()}:`
  prefixes.push(keyPrefix)
  const first = new OnlineRoomPresenceService({ redis: redis!, keyPrefix, ttlSeconds: 2, graceSeconds: 1 })
  const second = new OnlineRoomPresenceService({ redis: redis!, keyPrefix, ttlSeconds: 2, graceSeconds: 1 })
  const a = await first.registerConnection('room-5', 'user-5')
  const b = await second.registerConnection('room-5', 'user-5')
  await first.unregisterConnection(a.registration)
  assert.equal(await second.liveConnectionCount('room-5', 'user-5'), 1)
  const final = await second.unregisterConnection(b.registration)
  assert.equal(final.graceStarted, true)
  await first.disconnect()
  await second.disconnect()
})

test('heartbeat refreshes only Redis presence and does not create a second connection', { skip: !redisIsolated }, async () => {
  const service = presence()
  const registered = await service.registerConnection('room-6', 'user-6')
  await service.refreshConnection(registered.registration)
  assert.equal(await service.liveConnectionCount('room-6', 'user-6'), 1)
  await service.disconnect()
})

test('expired connection lease starts the grace lifecycle through Redis', { skip: !redisIsolated }, async () => {
  const keyPrefix = `pocker:test:presence-lease:${randomUUID()}:`
  prefixes.push(keyPrefix)
  const service = new OnlineRoomPresenceService({ redis: redis!, keyPrefix, ttlSeconds: 1, graceSeconds: 1 })
  const registered = await service.registerConnection('room-lease', 'user-lease')
  let expired = false
  service.scheduleConnectionExpiry(registered.registration, async () => { expired = true })
  await new Promise(resolve => setTimeout(resolve, 1_150))
  assert.equal(expired, true)
  const claim = await service.claimExpiredGrace('room-lease', 'user-lease', Date.now() + 2_000)
  assert.equal(claim.claimed, true)
  await service.completeGraceDisconnect('room-lease', 'user-lease', claim.token!)
  await service.disconnect()
})

test('missing heartbeat connection is rejected without local fallback', { skip: !redisIsolated }, async () => {
  const service = presence()
  const registered = await service.registerConnection('room-7', 'user-7')
  await service.unregisterConnection(registered.registration)
  await assert.rejects(service.refreshConnection(registered.registration), (error: unknown) => error instanceof OnlineRoomPresenceError && error.code === 'CONNECTION_NOT_FOUND')
  await service.disconnect()
})

test('Redis failure returns controlled presence error', { skip: !redisIsolated }, async () => {
  const broken = new OnlineRoomPresenceService({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: `pocker:test:presence-broken:${randomUUID()}:` })
  await assert.rejects(broken.registerConnection('room-8', 'user-8'), (error: unknown) => error instanceof OnlineRoomPresenceError && error.code === 'REDIS_UNAVAILABLE')
  await broken.disconnect()
})

async function createRoom(): Promise<{ room: Awaited<ReturnType<typeof createAuthenticatedOnlineRoom>>; runtime: OnlineRoomRuntimeStore; ownerId: string; playerId: string }> {
  const ownerId = `presence-owner-${randomUUID()}`
  const runtimeStore = runtime()
  const room = await createAuthenticatedOnlineRoom(ownerId, {}, { runtime: runtimeStore })
  roomIds.push(room.room.roomId)
  const playerId = `presence-player-${randomUUID()}`
  const joined = await joinAuthenticatedOnlineRoom(playerId, room.room.roomCode, { concurrencyToken: room.concurrencyToken }, { runtime: runtimeStore })
  return { room: joined, runtime: runtimeStore, ownerId, playerId }
}

test('presence transition preserves active hand, cards, stacks, pot and contributions', { skip: !isolated }, async () => {
  const room = await createRoom()
  let current = room.room
  let result = await setAuthenticatedOnlineRoomReady(room.ownerId, current.room.roomCode, { concurrencyToken: current.concurrencyToken, ready: true }, { runtime: room.runtime })
  result = await setAuthenticatedOnlineRoomReady(room.playerId, current.room.roomCode, { concurrencyToken: result.concurrencyToken, ready: true }, { runtime: room.runtime })
  current = result
  const loaded = await room.runtime.get(current.room.roomId)
  assert.ok(loaded)
  const active = await room.runtime.update(current.room.roomId, loaded.runtimeRevision, state => startOnlineRoomHand(state, { deck: createStandardDeck() }))
  const before = active.state.pokerTable.currentHand
  assert.ok(before)
  const disconnected = await setAuthenticatedOnlineRoomPresence(room.ownerId, current.room.roomCode, false, { runtime: room.runtime })
  const disconnectedRecord = await room.runtime.get(current.room.roomId)
  assert.ok(disconnectedRecord)
  assert.equal(disconnectedRecord.state.pokerTable.players.find(player => player.playerId === room.ownerId)?.connected, false)
  assert.deepEqual(disconnectedRecord.state.pokerTable.currentHand, before)
  assert.equal(disconnectedRecord.state.pokerTable.currentHand?.pot, before.pot)
  const reconnected = await setAuthenticatedOnlineRoomPresence(room.ownerId, current.room.roomCode, true, { runtime: room.runtime })
  const reconnectedRecord = await room.runtime.get(current.room.roomId)
  assert.ok(reconnectedRecord)
  assert.equal(reconnected.room.pokerTable.players.find(player => player.playerId === room.ownerId)?.connected, true)
  assert.deepEqual(reconnectedRecord.state.pokerTable.currentHand, before)
  assert.equal(disconnected.room.pokerTable.currentHand?.pot, before.pot)
  assert.equal(reconnected.room.pokerTable.currentHand?.pot, before.pot)
})

test('scheduled grace expiry marks metadata disconnected without mutating the active hand', { skip: !isolated }, async () => {
  const room = await createRoom()
  let result = await setAuthenticatedOnlineRoomReady(room.ownerId, room.room.room.roomCode, { concurrencyToken: room.room.concurrencyToken, ready: true }, { runtime: room.runtime })
  result = await setAuthenticatedOnlineRoomReady(room.playerId, result.room.roomCode, { concurrencyToken: result.concurrencyToken, ready: true }, { runtime: room.runtime })
  const loaded = await room.runtime.get(result.room.roomId)
  assert.ok(loaded)
  const active = await room.runtime.update(result.room.roomId, loaded.runtimeRevision, state => startOnlineRoomHand(state, { deck: createStandardDeck() }))
  const before = active.state.pokerTable.currentHand
  assert.ok(before)

  const presenceService = presence()
  const registration = await presenceService.registerConnection(result.room.roomId, room.ownerId)
  const closed = await presenceService.unregisterConnection(registration.registration)
  assert.equal(closed.graceStarted, true)
  presenceService.scheduleGraceExpiry(result.room.roomId, room.ownerId, async () => {
    await setAuthenticatedOnlineRoomPresence(room.ownerId, result.room.roomCode, false, { runtime: room.runtime })
  })
  await new Promise(resolve => setTimeout(resolve, 1_150))

  const after = await room.runtime.get(result.room.roomId)
  assert.ok(after)
  assert.equal(after.state.pokerTable.players.find(player => player.playerId === room.ownerId)?.connected, false)
  assert.deepEqual(after.state.pokerTable.currentHand, before)
  await presenceService.disconnect()
})

test('disconnected seated player is excluded between hands without leaving the room', { skip: !isolated }, async () => {
  const room = await createRoom()
  const disconnected = await setAuthenticatedOnlineRoomPresence(room.ownerId, room.room.room.roomCode, false, { runtime: room.runtime })
  assert.equal(disconnected.room.pokerTable.players.some(player => player.playerId === room.ownerId), true)
  const stored = await room.runtime.get(disconnected.room.roomId)
  assert.ok(stored)
  assert.equal(stored.state.pokerTable.players.find(player => player.playerId === room.ownerId)?.connected, false)
  const next = startOnlineRoomHand(stored.state, { deck: createStandardDeck() })
  assert.equal(next.pokerTable.currentHand, null)
  assert.equal(next.pokerTable.players.some(player => player.playerId === room.ownerId), true)
})
