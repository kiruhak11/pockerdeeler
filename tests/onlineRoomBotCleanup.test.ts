import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { ensureOnlinePokerBots } from '../server/services/botIdentityService'
import { closeEmptyPublicOnlineRoomsCreatedByBots, createAuthenticatedOnlineRoom, getAuthenticatedOnlineRoom, joinAuthenticatedOnlineRoom, leaveAuthenticatedOnlineRoom, listPublicOnlineRooms, markBotOnlyOnlineRoomDraining, reconcileDrainingOnlineRooms, resolveOnlineRoomCode } from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { OnlineRoomTurnTimerService } from '../server/services/onlineRoomTurnTimerService'
import { OnlineRoomPresenceService } from '../server/services/onlineRoomPresenceService'

const dbUrl = process.env.DATABASE_URL
const sourceRedisUrl = process.env.ONLINE_POKER_BOT_TEST_REDIS_URL ?? process.env.ONLINE_ROOM_TEST_REDIS_URL
const redisUrl = sourceRedisUrl?.replace(/\/(\d+)$/, (_match, index: string) => `/${Number(index) + 1}`)
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const runtime = new OnlineRoomRuntimeStore({ redisUrl: redisUrl ?? 'redis://127.0.0.1:6379/4' })
const timer = new OnlineRoomTurnTimerService({ redisUrl: redisUrl ?? 'redis://127.0.0.1:6379/4', keyPrefix: `pocker:test:bot-room-cleanup:${randomUUID()}:` })
const presence = new OnlineRoomPresenceService({ redisUrl: redisUrl ?? 'redis://127.0.0.1:6379/4', keyPrefix: `pocker:test:bot-room-cleanup-presence:${randomUUID()}:` })
let roomId: string | null = null
let ownerId: string | null = null
let joinerId: string | null = null
let humanId: string | null = null

before(async () => {
  if (!isolated) return
  const bots = await ensureOnlinePokerBots()
  ownerId = bots[0]!.id
  joinerId = bots[1]!.id
})

after(async () => {
  if (roomId) {
    await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: roomId } })
    await db.onlineRoom.deleteMany({ where: { id: roomId } })
  }
  if (humanId) await db.user.deleteMany({ where: { id: humanId } })
  await runtime.disconnect()
  await timer.disconnect()
  await presence.disconnect()
  await db.$disconnect()
})

test('bot-only room drains durably, rejects a stale candidate and closes after safe cash-out', { skip: !isolated }, async () => {
  const created = await createAuthenticatedOnlineRoom(ownerId!, { visibility: 'PUBLIC', startingStack: 1_000, smallBlind: 5, bigBlind: 10 }, { runtime })
  roomId = created.room.roomId
  await db.onlineRoom.update({ where: { id: roomId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } })
  const seated = await db.onlineRoomPlayer.count({ where: { roomId, userId: ownerId!, status: 'ACTIVE' } })
  assert.equal(seated, 1)
  await closeEmptyPublicOnlineRoomsCreatedByBots([ownerId!], new Date(Date.now() - 30 * 60_000), { runtime })
  assert.equal((await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })).status, 'WAITING')
  assert.ok(await runtime.get(roomId), 'a seated bot-owned room must retain its runtime')
  assert.deepEqual(await resolveOnlineRoomCode(created.room.roomCode), { type: 'ONLINE', code: created.room.roomCode, targetId: roomId })

  const human = await db.user.create({ data: { username: `drain-human-${randomUUID()}`, passwordHash: 'test-only', balance: 5_000 }, select: { id: true } })
  humanId = human.id
  const humanSeat = await joinAuthenticatedOnlineRoom(humanId, created.room.roomCode, {}, { runtime })
  assert.equal(await markBotOnlyOnlineRoomDraining(roomId, { runtime, presence }), false, 'an active/reconnecting human reservation blocks drain')
  await leaveAuthenticatedOnlineRoom(humanId, created.room.roomCode, { concurrencyToken: humanSeat.concurrencyToken, expectedRoomVersion: humanSeat.room.roomVersion }, { runtime })

  assert.deepEqual(await Promise.all([
    markBotOnlyOnlineRoomDraining(roomId, { runtime, presence }),
    markBotOnlyOnlineRoomDraining(roomId, { runtime, presence })
  ]), [true, true])
  assert.equal((await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })).status, 'DRAINING')
  assert.equal((await listPublicOnlineRooms({ runtime })).some(item => item.code === created.room.roomCode), false)
  await assert.rejects(joinAuthenticatedOnlineRoom(joinerId!, created.room.roomCode, {}, { runtime }), (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'DRAINING'))
  assert.equal(await db.onlineRoomPlayer.count({ where: { roomId, userId: joinerId!, status: { in: ['RESERVING', 'ACTIVE'] } } }), 0)

  const ownerView = await getAuthenticatedOnlineRoom(ownerId!, created.room.roomCode, { runtime, timer, presence })
  await leaveAuthenticatedOnlineRoom(ownerId!, created.room.roomCode, { concurrencyToken: ownerView.concurrencyToken, expectedRoomVersion: ownerView.room.roomVersion }, { runtime, timer, presence })
  const record = await runtime.get(roomId)
  assert.equal(record, null, 'normal last-seat lifecycle removes room runtime')
  assert.equal(await db.onlineRoomPlayer.count({ where: { roomId, status: { in: ['RESERVING', 'ACTIVE', 'CASH_OUT_PENDING'] } } }), 0)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `online-cashout:${roomId}:${ownerId}:0` } }), 1)
  const stored = await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })
  assert.equal(stored.status, 'CLOSED')

  // Simulate a process stopping after the durable drain marker but before close.
  await db.onlineRoom.update({ where: { id: roomId }, data: { status: 'DRAINING' } })
  assert.equal(await reconcileDrainingOnlineRooms({ runtime, timer, presence }), 1)
  assert.equal((await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })).status, 'CLOSED')
  await db.onlineRoom.update({ where: { id: roomId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } })
  await closeEmptyPublicOnlineRoomsCreatedByBots([ownerId!], new Date(Date.now() - 30 * 60_000), { runtime })
  assert.equal(
    await closeEmptyPublicOnlineRoomsCreatedByBots([ownerId!], new Date(Date.now() - 30 * 60_000), { runtime }),
    0,
    'already-cleaned CLOSED rows must not be reprocessed on later orchestrator ticks'
  )
})
