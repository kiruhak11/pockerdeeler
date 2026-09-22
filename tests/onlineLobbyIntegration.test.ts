import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'
import { createAuthenticatedOnlineRoom, joinAuthenticatedOnlineRoom, listPublicOnlineRooms } from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const roomIds: string[] = []

function runtime(): OnlineRoomRuntimeStore {
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix: 'pocker:online-room-runtime:v1:', ttlSeconds: 120 })
}

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test.before(async () => { if (isolated) await redis!.connect() })
test.afterEach(async () => {
  if (!isolated) return
  const keys = await redis!.keys('pocker:online-room-runtime:v1:*')
  if (keys.length > 0) await redis!.del(...keys)
})
test.after(async () => {
  if (isolated) redis!.disconnect()
  if (dbUrl && roomIds.length) {
    await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: roomIds } } })
    await db.onlineRoom.deleteMany({ where: { id: { in: roomIds } } })
  }
  await db.$disconnect()
})

test('main code input uses the unified resolver and preserves HOME/ONLINE routing', async () => {
  const page = await source('app/pages/index.vue')
  assert.match(page, /\/api\/rooms\/resolve\?code=/)
  assert.match(page, /`\/room\/\$\{result\.code\}\/join`/)
  assert.match(page, /`\/online\/\$\{result\.code\}`/)
  assert.doesNotMatch(page, /startsWith\(['"]ONLINE|code\.startsWith\(/)
})

test('unknown resolver result has a user-facing error', async () => {
  const page = await source('app/pages/index.vue')
  assert.match(page, /Стол с таким кодом не найден/)
})

test('ONLINE create sends no owner identity and navigates to the server room code', async () => {
  const page = await source('app/pages/online/create.vue')
  assert.match(page, /POST.*\/api\/online\/rooms|method: 'POST'/s)
  assert.doesNotMatch(page, /ownerId|userId/)
  assert.match(page, /navigateTo\(`\/online\/\$\{result\.room\.roomCode\}`\)/)
})

test('private creation keeps the secret out of URL and browser storage', async () => {
  const page = await source('app/pages/online/create.vue')
  assert.match(page, /type="password"/)
  assert.doesNotMatch(page, /localStorage|sessionStorage/)
  assert.doesNotMatch(page, /navigateTo\([^\n]*privateJoinSecret/)
})

test('rooms page keeps HOME tabs below a top-level HOME/ONLINE switch', async () => {
  const page = await source('app/pages/rooms.vue')
  assert.match(page, /С реальными картами/)
  assert.match(page, />Онлайн</)
  assert.match(page, /<LobbyDirectory \/>/)
  assert.match(page, /<OnlineLobbyDirectory v-else \/>/)
})

test('online lobby exposes only public lobby-safe fields', async () => {
  const component = await source('app/components/room/OnlineLobbyDirectory.vue')
  assert.match(component, /\/api\/online\/rooms/)
  assert.match(component, /room\.code/)
  assert.match(component, /room\.playerCount/)
  assert.doesNotMatch(component, /privateJoinSecret|runtimeRevision|holeCards|burnCards|deck|roomId/)
})

test('closed ONLINE tab explains code-only access without listing private rooms', async () => {
  const component = await source('app/components/room/OnlineLobbyDirectory.vue')
  assert.match(component, /Закрытые онлайн-комнаты доступны по коду/)
  assert.doesNotMatch(component, /privateRooms|PRIVATE.*rooms|api\/online\/rooms\/private/)
})

test('ONLINE join page uses the existing authenticated join endpoint and no password URL', async () => {
  const page = await source('app/pages/online/[code].vue')
  assert.match(page, /\/api\/online\/rooms\/\$\{encodeURIComponent\(code\.value\)\}\/join/)
  assert.match(page, /type="password"/)
  assert.match(page, /\/login\?redirect=/)
  assert.doesNotMatch(page, /joinSecret.*URL|\?joinSecret|&joinSecret/)
})

test('table UI stays isolated from HOME route and browser poker logic', async () => {
  const table = await source('app/components/online/OnlinePokerTable.vue')
  const page = await source('app/pages/online/[code].vue')
  assert.doesNotMatch(table, /evaluateWinner|resolveShowdown|buildPots|finishHand/)
  assert.match(page, /@action="socket\.sendAction"/)
  assert.match(page, /<NuxtLink class="btn" to="\/rooms">/)
})

test('responsive main and rooms styles keep mobile controls inside one column', async () => {
  const main = await source('app/pages/index.vue')
  const rooms = await source('app/pages/rooms.vue')
  const lobby = await source('app/components/room/OnlineLobbyDirectory.vue')
  assert.match(main, /@media \(max-width: 700px\)/)
  assert.match(rooms, /@media \(max-width: 700px\)/)
  assert.match(lobby, /@media \(max-width: 600px\)/)
  assert.match(main, /home-page__choices \{ grid-template-columns: 1fr; \}/)
})

test('public ONLINE room appears in the lobby and private room does not', { skip: !isolated }, async () => {
  const publicRoom = await createAuthenticatedOnlineRoom(`lobby-public-${randomUUID()}`, {}, { runtime: runtime() })
  const privateRoom = await createAuthenticatedOnlineRoom(`lobby-private-${randomUUID()}`, { visibility: 'PRIVATE', privateJoinSecret: 'lobby-secret' }, { runtime: runtime() })
  roomIds.push(publicRoom.room.roomId, privateRoom.room.roomId)
  const rooms = await listPublicOnlineRooms()
  assert.equal(rooms.some(room => room.code === publicRoom.room.roomCode), true)
  assert.equal(rooms.some(room => room.code === privateRoom.room.roomCode), false)
  assert.equal(JSON.stringify(rooms).includes('privateJoinSecret'), false)
  assert.equal(JSON.stringify(rooms).includes('runtimeRevision'), false)
})

test('lobby DTO contains only public code, count, capacity, status and createdAt', { skip: !isolated }, async () => {
  const room = await createAuthenticatedOnlineRoom(`lobby-shape-${randomUUID()}`, {}, { runtime: runtime() })
  roomIds.push(room.room.roomId)
  const entry = (await listPublicOnlineRooms()).find(item => item.code === room.room.roomCode)
  assert.ok(entry)
  assert.deepEqual(Object.keys(entry!).sort(), ['code', 'createdAt', 'maxPlayers', 'playerCount', 'status'])
})

test('private first join can use a server-selected revision without a client token', { skip: !isolated }, async () => {
  const owner = await createAuthenticatedOnlineRoom(`join-private-${randomUUID()}`, { visibility: 'PRIVATE', privateJoinSecret: 'join-secret' }, { runtime: runtime() })
  roomIds.push(owner.room.roomId)
  const joined = await joinAuthenticatedOnlineRoom(`joiner-${randomUUID()}`, owner.room.roomCode, { joinSecret: 'join-secret' }, { runtime: runtime() })
  assert.equal(joined.room.pokerTable.players.length, 2)
  assert.equal(joined.room.pokerTable.players.some(player => player.playerId === owner.room.ownerId), true)
})

test('private first join rejects a wrong password without changing membership', { skip: !isolated }, async () => {
  const owner = await createAuthenticatedOnlineRoom(`join-wrong-${randomUUID()}`, { visibility: 'PRIVATE', privateJoinSecret: 'join-secret' }, { runtime: runtime() })
  roomIds.push(owner.room.roomId)
  await assert.rejects(joinAuthenticatedOnlineRoom(`wrong-${randomUUID()}`, owner.room.roomCode, { joinSecret: 'wrong' }, { runtime: runtime() }))
  const loaded = await (runtime()).get(owner.room.roomId)
  assert.equal(loaded?.state.pokerTable.players.length, 1)
})

test('public first join without a token is supported while duplicate membership remains server-rejected', { skip: !isolated }, async () => {
  const owner = await createAuthenticatedOnlineRoom(`join-public-${randomUUID()}`, {}, { runtime: runtime() })
  roomIds.push(owner.room.roomId)
  const runtimeStore = runtime()
  const joined = await joinAuthenticatedOnlineRoom(`public-joiner-${randomUUID()}`, owner.room.roomCode, {}, { runtime: runtimeStore })
  assert.equal(joined.room.pokerTable.players.length, 2)
  await assert.rejects(joinAuthenticatedOnlineRoom(owner.room.ownerId!, owner.room.roomCode, {}, { runtime: runtimeStore }))
})

test('main and rooms entry points expose ONLINE creation', async () => {
  const main = await source('app/pages/index.vue')
  const rooms = await source('app/pages/rooms.vue')
  assert.match(main, /Создать онлайн-стол/)
  assert.match(main, /\/online\/create/)
  assert.match(rooms, /\/online\/create/)
})
