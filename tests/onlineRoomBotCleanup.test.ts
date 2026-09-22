import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { ensureOnlinePokerBots } from '../server/services/botIdentityService'
import { closeEmptyPublicOnlineRoomsCreatedByBots, createAuthenticatedOnlineRoom, leaveAuthenticatedOnlineRoom, resolveOnlineRoomCode } from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'

const dbUrl = process.env.DATABASE_URL
const sourceRedisUrl = process.env.ONLINE_POKER_BOT_TEST_REDIS_URL ?? process.env.ONLINE_ROOM_TEST_REDIS_URL
const redisUrl = sourceRedisUrl?.replace(/\/(\d+)$/, (_match, index: string) => `/${Number(index) + 1}`)
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const runtime = new OnlineRoomRuntimeStore({ redisUrl: redisUrl ?? 'redis://127.0.0.1:6379/4' })
let roomId: string | null = null
let ownerId: string | null = null

before(async () => {
  if (!isolated) return
  ownerId = (await ensureOnlinePokerBots())[0]!.id
})

after(async () => {
  if (roomId) {
    await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: roomId } })
    await db.onlineRoom.deleteMany({ where: { id: roomId } })
  }
  await runtime.disconnect()
  await db.$disconnect()
})

test('stale empty bot-created public room closes only after its seat is cashed out', { skip: !isolated }, async () => {
  const created = await createAuthenticatedOnlineRoom(ownerId!, { visibility: 'PUBLIC', startingStack: 1_000, smallBlind: 5, bigBlind: 10 }, { runtime })
  roomId = created.room.roomId
  await db.onlineRoom.update({ where: { id: roomId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } })
  const seated = await db.onlineRoomPlayer.count({ where: { roomId, userId: ownerId!, status: 'ACTIVE' } })
  assert.equal(seated, 1)
  await closeEmptyPublicOnlineRoomsCreatedByBots([ownerId!], new Date(Date.now() - 30 * 60_000), { runtime })
  assert.equal((await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })).status, 'WAITING')
  assert.ok(await runtime.get(roomId), 'a seated bot-owned room must retain its runtime')
  assert.deepEqual(await resolveOnlineRoomCode(created.room.roomCode), { type: 'ONLINE', code: created.room.roomCode, targetId: roomId })

  await leaveAuthenticatedOnlineRoom(ownerId!, created.room.roomCode, { concurrencyToken: created.concurrencyToken, expectedRoomVersion: created.room.roomVersion }, { runtime })
  const record = await runtime.get(roomId)
  assert.equal(record?.state.pokerTable.players.length, 0)

  assert.ok(await closeEmptyPublicOnlineRoomsCreatedByBots([ownerId!], new Date(Date.now() - 30 * 60_000), { runtime }) >= 1)
  const stored = await db.onlineRoom.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })
  assert.equal(stored.status, 'CLOSED')
})
