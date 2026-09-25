import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { createAuthenticatedOnlineRoom } from '../server/services/onlineRoomApiService'
import { inviteFriendToOnlineRoom } from '../server/services/onlineRoomInviteService'
import { issueUserAuthToken } from '../server/services/userAccountService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { joinOnlineRoom, setOnlineRoomReady, startOnlineRoomHand } from '../server/utils/pokerOnlineRoom'
import { createStandardDeck } from '../server/utils/pokerDeck'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const userIds: string[] = []
const roomIds: string[] = []
const runtimePrefixes: string[] = []

function runtime() {
  const keyPrefix = `pocker:test:online-room-invite:${randomUUID()}:`
  runtimePrefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 120 })
}

async function account(label: string) {
  const balance = 50_000
  const user = await db.user.create({
    data: {
      username: `invite_${label}_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      passwordHash: 'invite-test',
      balance,
      wallet: { create: { balance: BigInt(balance) } }
    }
  })
  userIds.push(user.id)
  return { user, token: await issueUserAuthToken(user.id) }
}

async function friends(userAId: string, userBId: string) {
  await db.friendship.create({
    data: userAId < userBId ? { userAId, userBId } : { userAId: userBId, userBId: userAId }
  })
}

async function room(ownerId: string, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const store = runtime()
  const created = await createAuthenticatedOnlineRoom(ownerId, {
    visibility,
    ...(visibility === 'PRIVATE' ? { privateJoinSecret: 'invite-room-password' } : {})
  }, { runtime: store })
  roomIds.push(created.room.roomId)
  return { store, created }
}

function status(error: unknown): number | undefined {
  return (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
}

test.before(async () => { if (isolated) await redis!.connect() })
test.after(async () => {
  if (roomIds.length) {
    await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: roomIds } } })
    await db.onlineRoom.deleteMany({ where: { id: { in: roomIds } } })
  }
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } })
  if (isolated) {
    for (const prefix of runtimePrefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
  await db.$disconnect()
})

test('authenticated room member invites a friend through the existing notification queue', { skip: !isolated }, async () => {
  const sender = await account('sender')
  const friend = await account('friend')
  await friends(sender.user.id, friend.user.id)
  const { created, store } = await room(sender.user.id)

  const result = await inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store })
  const event = await db.telegramUserEvent.findFirstOrThrow({ where: { userId: friend.user.id } })
  assert.deepEqual(result, { sent: true, duplicate: false })
  assert.equal(event.category, 'games')
  assert.match(event.text, new RegExp(sender.user.username))
  assert.match(event.text, new RegExp(`ONLINE-стол ${created.room.roomCode}`))
  assert.match(event.text, new RegExp(`/online/${created.room.roomCode}\\?join=1`))
})

test('non-friends and unauthenticated senders cannot create an invite', { skip: !isolated }, async () => {
  const sender = await account('guard')
  const target = await account('target')
  const { created, store } = await room(sender.user.id)
  await assert.rejects(inviteFriendToOnlineRoom({ token: sender.token, friendUserId: target.user.id, roomCode: created.room.roomCode }, { runtime: store }), error => status(error) === 403)
  await assert.rejects(inviteFriendToOnlineRoom({ token: 'invalid-session-token-invalid-session-token', friendUserId: target.user.id, roomCode: created.room.roomCode }, { runtime: store }), error => status(error) === 401)
})

test('closed ONLINE rooms reject invites', { skip: !isolated }, async () => {
  const sender = await account('closed_sender')
  const friend = await account('closed_friend')
  await friends(sender.user.id, friend.user.id)
  const { created, store } = await room(sender.user.id)
  await db.onlineRoom.update({ where: { id: created.room.roomId }, data: { status: 'CLOSED' } })
  await assert.rejects(inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store }), error => status(error) === 409)
  assert.equal(await db.telegramUserEvent.count({ where: { userId: friend.user.id } }), 0)
})

test('PUBLIC ACTIVE and FULL rooms can be invited without creating seats', { skip: !isolated }, async () => {
  const sender = await account('open_sender')
  const friend = await account('open_friend')
  await friends(sender.user.id, friend.user.id)
  for (const mode of ['ACTIVE', 'FULL'] as const) {
    const { created, store } = await room(sender.user.id)
    const record = await store.get(created.room.roomId)
    assert.ok(record)
    let next = record!.state
    if (mode === 'ACTIVE') {
      const secondPlayer = randomUUID()
      next = joinOnlineRoom(next, { playerId: secondPlayer, stack: 1_000, seat: 2 })
      next = setOnlineRoomReady(next, sender.user.id, true)
      next = setOnlineRoomReady(next, secondPlayer, true)
      next = startOnlineRoomHand(next, { deck: createStandardDeck() })
      assert.equal(next.pokerTable.status, 'IN_HAND')
    } else {
      for (let seat = 2; seat <= 6; seat++) next = joinOnlineRoom(next, { playerId: randomUUID(), stack: 1_000, seat })
      assert.equal(next.pokerTable.players.length, 6)
    }
    await store.update(created.room.roomId, record!.runtimeRevision, () => next)
    const result = await inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store })
    assert.equal(result.sent, true)
    assert.equal((await store.get(created.room.roomId))?.state.pokerTable.players.length, mode === 'ACTIVE' ? 2 : 6)
  }
  assert.equal(await db.telegramUserEvent.count({ where: { userId: friend.user.id } }), 2)
})

test('PRIVATE invite notification and target link never include the room password', { skip: !isolated }, async () => {
  const sender = await account('private_sender')
  const friend = await account('private_friend')
  await friends(sender.user.id, friend.user.id)
  const { created, store } = await room(sender.user.id, 'PRIVATE')
  await inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store })
  const event = await db.telegramUserEvent.findFirstOrThrow({ where: { userId: friend.user.id } })
  assert.equal(event.text.includes('invite-room-password'), false)
  assert.equal(event.text.includes('privateJoinSecret'), false)
  assert.match(event.text, new RegExp(`/online/${created.room.roomCode}\\?join=1`))
})

test('invite entry reuses public spectator and private password access flows', async () => {
  const table = await readFile(new URL('../app/components/online/OnlinePokerTable.vue', import.meta.url), 'utf8')
  const page = await readFile(new URL('../app/pages/online/[code].vue', import.meta.url), 'utf8')
  assert.match(table, /OnlineFriendInviteModal v-if="!spectating"/)
  assert.match(table, /spectating && isWaiting && state\.pokerTable\.players\.length < state\.maxPlayers/)
  assert.match(page, /next\.visibility === 'PRIVATE'/)
  assert.match(page, /privateRoom\.value = true\s+joinPrompt\.value = true/)
  assert.match(page, /route\.query\.join === '1'/)
})

test('parallel invite clicks create one notification and UI link is code-only', { skip: !isolated }, async () => {
  const sender = await account('dedupe_sender')
  const friend = await account('dedupe_friend')
  await friends(sender.user.id, friend.user.id)
  const { created, store } = await room(sender.user.id)
  const [first, second] = await Promise.all([
    inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store }),
    inviteFriendToOnlineRoom({ token: sender.token, friendUserId: friend.user.id, roomCode: created.room.roomCode }, { runtime: store })
  ])
  assert.equal([first, second].filter(result => !result.duplicate).length, 1)
  assert.equal(await db.telegramUserEvent.count({ where: { userId: friend.user.id } }), 1)
  const component = await readFile(new URL('../app/components/online/OnlineFriendInviteModal.vue', import.meta.url), 'utf8')
  assert.match(component, /window\.location\.origin/)
  assert.match(component, /\?join=1/)
  assert.match(component, /@media \(max-width: 600px\)/)
  assert.doesNotMatch(component, /privateJoinSecret|privateJoinSecretHash|password.*URL|token.*roomLink/)
})
