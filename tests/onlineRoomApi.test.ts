import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'
import { createRoom } from '../server/services/roomService'
import { claimRoomCode, createPersistentOnlineRoom } from '../server/services/roomCodeRegistryService'
import {
  OnlineRoomApiError,
  applyAuthenticatedOnlineRoomAction,
  createAuthenticatedOnlineRoom,
  getAuthenticatedOnlineRoom,
  joinAuthenticatedOnlineRoom,
  leaveAuthenticatedOnlineRoom,
  resolveOnlineRoomCode,
  setAuthenticatedOnlineRoomReady,
  setAuthenticatedOnlineRoomSittingOut,
  startAuthenticatedOnlineRoomHand,
  type ApiOnlineRoomResult
} from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore, serializeOnlineRoomRuntimeState } from '../server/services/onlineRoomRuntimeStore'
import { setOnlineRoomReady, startOnlineRoomHand } from '../server/utils/pokerOnlineRoom'
import { applyTableAction, advanceTableStreet } from '../server/utils/pokerTableState'
import { getToCall } from '../server/utils/pokerBetting'
import { createStandardDeck } from '../server/utils/pokerDeck'
import { hashSecret } from '../server/services/authService'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const roomIds: string[] = []
const homeIds: string[] = []
const homeCodes: string[] = []
const prefixes: string[] = []

function runtime(): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:online-room-api:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 60 })
}

async function createRoomApi(options: { visibility?: 'PUBLIC' | 'PRIVATE'; secret?: string; startingStack?: number; smallBlind?: number; bigBlind?: number } = {}): Promise<{ result: ApiOnlineRoomResult; runtime: OnlineRoomRuntimeStore; ownerId: string }> {
  const ownerId = `owner-${randomUUID()}`
  const runtimeStore = runtime()
  const result = await createAuthenticatedOnlineRoom(ownerId, {
    visibility: options.visibility,
    ...(options.startingStack === undefined ? {} : { startingStack: options.startingStack }),
    ...(options.smallBlind === undefined ? {} : { smallBlind: options.smallBlind }),
    ...(options.bigBlind === undefined ? {} : { bigBlind: options.bigBlind }),
    ...(options.secret === undefined ? {} : { privateJoinSecret: options.secret })
  }, { runtime: runtimeStore })
  roomIds.push(result.room.roomId)
  return { result, runtime: runtimeStore, ownerId }
}

async function join(room: { result: ApiOnlineRoomResult; runtime: OnlineRoomRuntimeStore }, playerId = `player-${randomUUID()}`, extra: { joinSecret?: string; stack?: number; seat?: number } = {}): Promise<{ result: ApiOnlineRoomResult; playerId: string }> {
  const result = await joinAuthenticatedOnlineRoom(playerId, room.result.room.roomCode, {
    concurrencyToken: room.result.concurrencyToken,
    ...(extra.joinSecret === undefined ? {} : { joinSecret: extra.joinSecret }),
    ...(extra.stack === undefined ? {} : { stack: extra.stack }),
    ...(extra.seat === undefined ? {} : { seat: extra.seat })
  }, { runtime: room.runtime })
  room.result = result
  return { result, playerId }
}

async function readyBoth(room: { result: ApiOnlineRoomResult; runtime: OnlineRoomRuntimeStore }, ownerId: string, otherId: string): Promise<ApiOnlineRoomResult> {
  let result = await setAuthenticatedOnlineRoomReady(ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, ready: true }, { runtime: room.runtime })
  result = await setAuthenticatedOnlineRoomReady(otherId, result.room.roomCode, { concurrencyToken: result.concurrencyToken, ready: true }, { runtime: room.runtime })
  room.result = result
  return result
}

async function activeRoom(room: { result: ApiOnlineRoomResult; runtime: OnlineRoomRuntimeStore }, ownerId: string, otherId: string): Promise<ApiOnlineRoomResult> {
  await readyBoth(room, ownerId, otherId)
  const current = await room.runtime.get(room.result.room.roomId)
  assert.ok(current)
  const next = await room.runtime.update(room.result.room.roomId, current.runtimeRevision, state => startOnlineRoomHand(state, { deck: createStandardDeck() }))
  const result = await getAuthenticatedOnlineRoom(ownerId, next.state.roomCode, { runtime: room.runtime })
  room.result = result
  return result
}

test.before(async () => {
  if (isolated) {
    await redis!.connect()
  }
})

test.after(async () => {
  if (isolated) {
    for (const prefix of prefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length > 0) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
  if (dbUrl) {
    if (roomIds.length > 0) await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: roomIds } } })
    if (roomIds.length > 0) await db.onlineRoom.deleteMany({ where: { id: { in: roomIds } } })
    if (homeCodes.length > 0) await db.roomCodeRegistry.deleteMany({ where: { code: { in: homeCodes } } })
    if (homeIds.length > 0) await db.room.deleteMany({ where: { id: { in: homeIds } } })
  }
  await db.$disconnect()
})

test('resolve existing HOME code through the unified resolver', { skip: !isolated }, async () => {
  const home = await createRoom({ name: `Resolver HOME ${randomUUID()}`, startingStack: 100, maxPlayers: 6, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true }, 'http://test')
  const row = await db.room.findUniqueOrThrow({ where: { code: home.roomCode } })
  homeIds.push(row.id)
  assert.deepEqual(await resolveOnlineRoomCode(home.roomCode.toLowerCase()), { type: 'HOME', code: home.roomCode, targetId: row.id })
})

test('resolve ONLINE code without returning authorization data', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PRIVATE', secret: 'private-secret' })
  const resolved = await resolveOnlineRoomCode(room.result.room.roomCode)
  assert.deepEqual(resolved, { type: 'ONLINE', code: room.result.room.roomCode, targetId: room.result.room.roomId })
  assert.equal('privateJoinSecretHash' in resolved, false)
})

test('unknown room code returns NOT_FOUND', { skip: !isolated }, async () => {
  assert.deepEqual(await resolveOnlineRoomCode('ZZZZZZ'), { type: 'NOT_FOUND', code: 'ZZZZZZ' })
})

test('authenticated create uses session user as owner and creates runtime state', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  assert.equal(room.result.room.ownerId, room.ownerId)
  assert.equal(await room.runtime.get(room.result.room.roomId) !== null, true)
})

test('empty authenticated user is rejected as 401', { skip: !isolated }, async () => {
  await assert.rejects(createAuthenticatedOnlineRoom('', {}, { runtime: runtime() }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 401)
})

test('client ownerId cannot replace the authenticated owner', { skip: !isolated }, async () => {
  const room = await createAuthenticatedOnlineRoom('session-owner', { ownerSeat: 2, startingStack: 321, ...({ ownerId: 'forged-owner' } as Record<string, unknown>) } as never, { runtime: runtime() })
  roomIds.push(room.room.roomId)
  assert.equal(room.room.ownerId, 'session-owner')
})

test('public ONLINE room creation validates public settings', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PUBLIC' })
  assert.equal(room.result.room.visibility, 'PUBLIC')
  assert.equal((room.result.room as Record<string, unknown>).privateJoinSecret, undefined)
})

test('a non-member may spectate a public ONLINE hand without receiving players hole cards', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PUBLIC' })
  const joined = await join(room, 'spectator-gate-player')
  const active = await activeRoom(room, room.ownerId, joined.playerId)
  const spectatorId = `spectator-${randomUUID()}`
  const spectator = await getAuthenticatedOnlineRoom(spectatorId, active.room.roomCode, { runtime: room.runtime })
  assert.equal(spectator.room.visibility, 'PUBLIC')
  assert.ok(spectator.room.pokerTable.currentHand)
  assert.equal(spectator.room.pokerTable.players.some(player => player.playerId === spectatorId), false)
  assert.ok(spectator.room.pokerTable.currentHand.players.every(player => player.holeCards.length === 0))
})

test('a full public table remains viewable without a seat or poker permissions', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PUBLIC' })
  for (let seat = 2; seat <= 6; seat += 1) await join(room, `full-player-${seat}`, { seat })
  const spectatorId = `full-spectator-${randomUUID()}`
  const waiting = await getAuthenticatedOnlineRoom(spectatorId, room.result.room.roomCode, { runtime: room.runtime })
  assert.equal(waiting.room.pokerTable.players.length, 6)
  assert.equal(waiting.room.pokerTable.players.some(player => player.playerId === spectatorId), false)
  assert.equal(waiting.room.pokerTable.currentHand, null)
  const active = await activeRoom(room, room.ownerId, 'full-player-2')
  const observed = await getAuthenticatedOnlineRoom(spectatorId, active.room.roomCode, { runtime: room.runtime })
  const refreshed = await getAuthenticatedOnlineRoom(spectatorId, active.room.roomCode, { runtime: room.runtime })
  assert.equal(observed.room.pokerTable.players.length, 6)
  assert.equal(refreshed.room.pokerTable.players.length, 6)
  assert.ok(observed.room.pokerTable.currentHand?.players.every(player => player.holeCards.length === 0))
  assert.equal(JSON.stringify(observed).includes('burnCards'), false)
  assert.equal(JSON.stringify(observed).includes('deck'), false)
  await assert.rejects(setAuthenticatedOnlineRoomReady(spectatorId, active.room.roomCode, { concurrencyToken: observed.concurrencyToken, ready: true }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 404)
  await assert.rejects(startAuthenticatedOnlineRoomHand(spectatorId, active.room.roomCode, active.room.pokerTable.stateVersion, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 403)
  await assert.rejects(joinAuthenticatedOnlineRoom(spectatorId, active.room.roomCode, { concurrencyToken: observed.concurrencyToken }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 409)
})

test('ONLINE creation persists HOME poker settings and uses them for the first hand', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PUBLIC', startingStack: 321, smallBlind: 7, bigBlind: 14 })
  assert.equal(room.result.room.pokerTable.smallBlind, 7)
  assert.equal(room.result.room.pokerTable.bigBlind, 14)
  assert.equal(room.result.room.pokerTable.players[0]?.stack, 321)
  const player = await join(room, 'settings-player')
  const active = await activeRoom(room, room.ownerId, player.playerId)
  assert.equal(active.room.pokerTable.currentHand?.smallBlind, 7)
  assert.equal(active.room.pokerTable.currentHand?.bigBlind, 14)
  assert.equal(active.room.pokerTable.currentHand?.pot, 21)
})

test('ONLINE starting stack and blind settings reject invalid values server-side', { skip: !isolated }, async () => {
  await assert.rejects(createAuthenticatedOnlineRoom('invalid-settings', { startingStack: 0 }, { runtime: runtime() }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 400)
  await assert.rejects(createAuthenticatedOnlineRoom('invalid-blinds', { smallBlind: 20, bigBlind: 10 }, { runtime: runtime() }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 400)
})

test('private ONLINE creation stores no plaintext credential in metadata or safe state', { skip: !isolated }, async () => {
  const secret = `private-${randomUUID()}`
  const room = await createRoomApi({ visibility: 'PRIVATE', secret })
  const row = await db.onlineRoom.findUniqueOrThrow({ where: { id: room.result.room.roomId } })
  assert.notEqual(row.privateJoinSecretHash, secret)
  assert.equal(JSON.stringify(room.result).includes(secret), false)
  assert.equal(JSON.stringify(room.result).includes(row.privateJoinSecretHash!), false)
})

test('Redis runtime exists after authenticated creation', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const loaded = await room.runtime.get(room.result.room.roomId)
  assert.equal(loaded?.state.roomCode, room.result.room.roomCode)
})

test('Redis failure during creation closes metadata and leaves no active orphan', { skip: !isolated }, async () => {
  const broken = new OnlineRoomRuntimeStore({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: `pocker:test:broken:${randomUUID()}:` })
  await assert.rejects(createAuthenticatedOnlineRoom(`broken-${randomUUID()}`, {}, { runtime: broken }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 503)
  const row = await db.onlineRoom.findFirstOrThrow({ where: { ownerId: { startsWith: 'broken-' } }, orderBy: { createdAt: 'desc' } })
  roomIds.push(row.id)
  assert.equal(row.status, 'CLOSED')
  assert.equal(await broken.get(row.id).catch(() => null), null)
})

test('GET returns player-safe state only', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const loaded = await getAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { runtime: room.runtime })
  assert.equal(loaded.room.roomId, room.result.room.roomId)
  assert.equal(loaded.room.pokerTable.currentHand, null)
})

test('other players hole cards are absent from GET safe state', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room)
  const active = await activeRoom(room, room.ownerId, player.playerId)
  const other = active.room.pokerTable.currentHand!.players.find(item => item.playerId === player.playerId)
  const mine = active.room.pokerTable.currentHand!.players.find(item => item.playerId === room.ownerId)
  assert.deepEqual(other?.holeCards, [])
  assert.equal(mine?.holeCards.length, 2)
})

test('GET safe state omits deck and burn cards', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room)
  const active = await activeRoom(room, room.ownerId, player.playerId)
  const encoded = JSON.stringify(active)
  assert.equal(encoded.includes('deck'), false)
  assert.equal(encoded.includes('burnCards'), false)
})

test('authenticated user joins a public room without a client playerId', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'joined-user')
  assert.equal(player.result.room.pokerTable.players.some(item => item.playerId === 'joined-user'), true)
})

test('private room accepts the correct credential server-side', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PRIVATE', secret: 'correct-secret' })
  const player = await join(room, 'private-user', { joinSecret: 'correct-secret' })
  assert.equal(player.result.room.pokerTable.players.length, 2)
})

test('private room rejects an invalid credential with 403', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PRIVATE', secret: 'correct-secret' })
  await assert.rejects(getAuthenticatedOnlineRoom('outsider', room.result.room.roomCode, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 403)
  await assert.rejects(joinAuthenticatedOnlineRoom('private-user', room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, joinSecret: 'wrong' }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 403)
})

test('duplicate authenticated membership is rejected', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  await join(room, 'duplicate-user')
  await assert.rejects(joinAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 409)
})

test('seventh player is rejected by the server table limit', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  for (let index = 2; index <= 6; index += 1) await join(room, `player-${index}`, { seat: index })
  await assert.rejects(joinAuthenticatedOnlineRoom('player-7', room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 409)
})

test('leave between hands releases the authenticated user seat', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  await join(room, 'leaving-user')
  const left = await leaveAuthenticatedOnlineRoom('leaving-user', room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken }, { runtime: room.runtime })
  room.result = left
  assert.equal(left.room.pokerTable.players.some(item => item.playerId === 'leaving-user'), false)
})

test('owner transfer after authenticated leave is persisted in metadata', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  await join(room, 'next-owner', { seat: 2 })
  const left = await leaveAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken }, { runtime: room.runtime })
  const metadata = await db.onlineRoom.findUniqueOrThrow({ where: { id: left.room.roomId } })
  assert.equal(left.room.ownerId, 'next-owner')
  assert.equal(metadata.ownerId, 'next-owner')
})

test('leave during a hand is deferred without mutating the internal hand players', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'deferred-user')
  await activeRoom(room, room.ownerId, player.playerId)
  const before = (await room.runtime.get(room.result.room.roomId))!.state.pokerTable.currentHand!.players.length
  const left = await leaveAuthenticatedOnlineRoom(player.playerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken }, { runtime: room.runtime })
  assert.equal(left.room.pokerTable.players.find(item => item.playerId === player.playerId)?.connected, false)
  assert.equal((await room.runtime.get(room.result.room.roomId))!.state.pokerTable.currentHand!.players.length, before)
})

test('ready mutation uses the authenticated user and CAS token', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const ready = await setAuthenticatedOnlineRoomReady(room.ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, ready: true }, { runtime: room.runtime })
  assert.equal(ready.room.pokerTable.players.find(item => item.playerId === room.ownerId)?.ready, true)
})

test('sitting-out mutation persists through the runtime store', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const updated = await setAuthenticatedOnlineRoomSittingOut(room.ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, sittingOut: true }, { runtime: room.runtime })
  assert.equal(updated.room.pokerTable.players.find(item => item.playerId === room.ownerId)?.sittingOut, true)
})

test('a user cannot mutate another player membership', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  await assert.rejects(setAuthenticatedOnlineRoomReady('not-seated', room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, ready: true }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 404)
})

test('stale concurrency token returns 409', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const token = room.result.concurrencyToken
  const first = await setAuthenticatedOnlineRoomReady(room.ownerId, room.result.room.roomCode, { concurrencyToken: token, ready: true }, { runtime: room.runtime })
  assert.notEqual(first.concurrencyToken, token)
  await assert.rejects(setAuthenticatedOnlineRoomReady(room.ownerId, room.result.room.roomCode, { concurrencyToken: token, ready: false }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 409)
})

test('concurrent mutations allow only one writer for one token', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const token = room.result.concurrencyToken
  const results = await Promise.allSettled([
    setAuthenticatedOnlineRoomReady(room.ownerId, room.result.room.roomCode, { concurrencyToken: token, ready: true }, { runtime: room.runtime }),
    setAuthenticatedOnlineRoomSittingOut(room.ownerId, room.result.room.roomCode, { concurrencyToken: token, sittingOut: true }, { runtime: room.runtime })
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected').length, 1)
})

test('Redis unavailable returns controlled 503 and does not mutate', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const broken = new OnlineRoomRuntimeStore({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: `pocker:test:unavailable:${randomUUID()}:` })
  await assert.rejects(getAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { runtime: broken }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 503)
  const state = await room.runtime.get(room.result.room.roomId)
  assert.equal(state?.runtimeRevision, 1)
})

test('corrupted Redis runtime returns controlled 503', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const key = room.runtime.keyFor(room.result.room.roomId)
  await redis!.set(key, '{not-json')
  await assert.rejects(getAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.statusCode === 503)
})

test('HOME flow remains separate from ONLINE runtime state', { skip: !isolated }, async () => {
  const home = await createRoom({ name: `HOME regression ${randomUUID()}`, startingStack: 100, maxPlayers: 6, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true }, 'http://test')
  const row = await db.room.findUniqueOrThrow({ where: { code: home.roomCode } })
  homeIds.push(row.id)
  const resolved = await resolveOnlineRoomCode(home.roomCode)
  assert.equal(resolved.type, 'HOME')
  assert.equal(await redis!.keys('pocker:online-room-runtime:v1:*').then(keys => keys.length), 0)
})

test('global HOME/ONLINE collision remains protected by persistent registry', { skip: !isolated }, async () => {
  const homeCode = 'AB2345'
  const retryCode = 'CD2345'
  const home = await db.$transaction(async tx => {
    const row = await tx.room.create({
      data: {
        id: randomUUID(),
        code: homeCode,
        name: 'Deterministic collision fixture',
        status: 'lobby',
        dealerSecretHash: 'fixture-dealer-secret-hash',
        settings: {}
      }
    })
    await claimRoomCode(tx, { code: homeCode, roomType: 'HOME', targetId: row.id })
    return row
  })
  homeIds.push(home.id)
  homeCodes.push(home.code)

  const candidates = [homeCode, retryCode]
  const online = await createPersistentOnlineRoom({
    ownerId: `collision-${randomUUID()}`,
    visibility: 'PUBLIC',
    codeGenerator: () => candidates.shift() ?? retryCode
  })
  roomIds.push(online.id)
  assert.equal(online.roomCode, retryCode)
  assert.equal((await db.room.findUniqueOrThrow({ where: { id: home.id } })).code, homeCode)
  assert.equal(await db.onlineRoom.count({ where: { roomCode: homeCode } }), 0)
  assert.deepEqual(await resolveOnlineRoomCode(homeCode), { type: 'HOME', code: homeCode, targetId: home.id })
  assert.deepEqual(await resolveOnlineRoomCode(retryCode), { type: 'ONLINE', code: retryCode, targetId: online.id })
})

test('safe result never contains runtime envelope or private hash', { skip: !isolated }, async () => {
  const room = await createRoomApi({ visibility: 'PRIVATE', secret: 'envelope-secret' })
  const loaded = await getAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { runtime: room.runtime })
  const payload = JSON.stringify(loaded)
  assert.equal(payload.includes('runtimeRevision'), false)
  assert.equal(payload.includes('privateJoinSecret'), false)
  assert.equal(payload.includes(hashSecret('envelope-secret')), false)
})

test('runtime serializer is not exposed by the API result', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const internal = (await room.runtime.get(room.result.room.roomId))!.state
  const raw = serializeOnlineRoomRuntimeState(internal)
  assert.equal(JSON.stringify(room.result).includes(raw), false)
  assert.equal(JSON.stringify(room.result).includes('schemaVersion'), false)
})

test('roomVersion remains domain-controlled while API CAS uses an opaque token', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const before = room.result.room.roomVersion
  const previousToken = room.result.concurrencyToken
  const updated = await setAuthenticatedOnlineRoomReady(room.ownerId, room.result.room.roomCode, { concurrencyToken: room.result.concurrencyToken, ready: true }, { runtime: room.runtime })
  assert.equal(updated.room.roomVersion, before + 1)
  assert.notEqual(updated.concurrencyToken, previousToken)
})

test('authenticated start service uses owner session and the existing hand engine', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'ws-start-player')
  await readyBoth(room, room.ownerId, player.playerId)
  const before = room.result.room.pokerTable.stateVersion
  const started = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, before, { runtime: room.runtime })
  assert.equal(started.room.status, 'IN_HAND')
  assert.equal(started.room.pokerTable.currentHand?.players.length, 2)
})

test('authenticated action service applies through PokerTableState', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'ws-action-player')
  await activeRoom(room, room.ownerId, player.playerId)
  const expected = room.result.room.pokerTable.stateVersion
  const first = await applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, {
    actionId: 'ws-action-123',
    expectedTableStateVersion: expected,
    action: { type: 'call' }
  }, { runtime: room.runtime })
  assert.equal(first.duplicate, false)
  assert.equal(first.room.pokerTable.stateVersion, expected + 1)
})

test('exact authenticated action retry does not apply twice', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'ws-retry-player')
  await activeRoom(room, room.ownerId, player.playerId)
  const expected = room.result.room.pokerTable.stateVersion
  const input = { actionId: 'ws-retry-123', expectedTableStateVersion: expected, action: { type: 'call' as const } }
  const first = await applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, input, { runtime: room.runtime })
  const retry = await applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, input, { runtime: room.runtime })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.room.pokerTable.stateVersion, first.room.pokerTable.stateVersion)
  assert.equal((await room.runtime.get(room.result.room.roomId))!.state.pokerTable.stateVersion, first.room.pokerTable.stateVersion)
})

test('same authenticated action id with another payload is a conflict', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'ws-conflict-player')
  await activeRoom(room, room.ownerId, player.playerId)
  const expected = room.result.room.pokerTable.stateVersion
  const input = { actionId: 'ws-conflict-123', expectedTableStateVersion: expected, action: { type: 'call' as const } }
  await applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, input, { runtime: room.runtime })
  await assert.rejects(applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, {
    actionId: input.actionId,
    expectedTableStateVersion: expected,
    action: { type: 'fold' }
  }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.code === 'ACTION_CONFLICT' && error.statusCode === 409)
})

test('stale table action is rejected before poker mutation', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'ws-stale-player')
  await activeRoom(room, room.ownerId, player.playerId)
  const expected = room.result.room.pokerTable.stateVersion
  await applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, {
    actionId: 'ws-stale-first', expectedTableStateVersion: expected, action: { type: 'call' }
  }, { runtime: room.runtime })
  await assert.rejects(applyAuthenticatedOnlineRoomAction(room.ownerId, room.result.room.roomCode, {
    actionId: 'ws-stale-second', expectedTableStateVersion: expected, action: { type: 'call' }
  }, { runtime: room.runtime }), (error: unknown) => error instanceof OnlineRoomApiError && error.code === 'STALE_STATE' && error.statusCode === 409)
})

test('ONLINE API settles a contested hand exactly once and allows the next hand', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'settlement-player')
  await readyBoth(room, room.ownerId, player.playerId)
  room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })
  const startingTotal = room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0) + room.result.room.pokerTable.currentHand!.pot
  let lastAction: { userId: string; input: { actionId: string; expectedTableStateVersion: number; action: { type: 'check' | 'call' } } } | undefined

  for (let guard = 0; guard < 100; guard += 1) {
    const hand = room.result.room.pokerTable.currentHand
    if (!hand || hand.street === 'FINISHED') break
    assert.ok(hand.currentActor !== null)
    const actor = hand.players.find(item => item.seat === hand.currentActor)!
    const input = {
      actionId: `settle-${guard}-${randomUUID()}`,
      expectedTableStateVersion: room.result.room.pokerTable.stateVersion,
      action: { type: (hand.currentBet > actor.streetContribution ? 'call' : 'check') as 'check' | 'call' }
    }
    lastAction = { userId: actor.playerId, input }
    room.result = await applyAuthenticatedOnlineRoomAction(actor.playerId, room.result.room.roomCode, input, { runtime: room.runtime })
  }

  assert.equal(room.result.room.pokerTable.currentHand?.street, 'FINISHED')
  assert.equal(room.result.room.pokerTable.status, 'WAITING')
  assert.equal(room.result.room.pokerTable.finalizedHandId, room.result.room.pokerTable.currentHand?.handId)
  assert.equal(room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0), startingTotal)
  assert.ok(lastAction)
  const retries = await Promise.all([
    applyAuthenticatedOnlineRoomAction(lastAction!.userId, room.result.room.roomCode, lastAction!.input, { runtime: room.runtime }),
    applyAuthenticatedOnlineRoomAction(lastAction!.userId, room.result.room.roomCode, lastAction!.input, { runtime: room.runtime })
  ])
  assert.equal(retries.every(retry => retry.duplicate), true)
  assert.deepEqual(retries[0]!.room.pokerTable.players, room.result.room.pokerTable.players)

  room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })
  assert.equal(room.result.room.pokerTable.handSequence, 2)
  assert.equal(room.result.room.pokerTable.currentHand?.street, 'PREFLOP')
})

test('ONLINE API settles an uncontested fold before starting the next hand', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'uncontested-player')
  await readyBoth(room, room.ownerId, player.playerId)
  room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })
  const hand = room.result.room.pokerTable.currentHand!
  const startingTotal = room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0) + hand.pot
  const actor = hand.players.find(item => item.seat === hand.currentActor)!
  room.result = await applyAuthenticatedOnlineRoomAction(actor.playerId, room.result.room.roomCode, {
    actionId: `uncontested-${randomUUID()}`,
    expectedTableStateVersion: room.result.room.pokerTable.stateVersion,
    action: { type: 'fold' }
  }, { runtime: room.runtime })
  assert.equal(room.result.room.pokerTable.currentHand?.street, 'FINISHED')
  assert.equal(room.result.room.pokerTable.status, 'WAITING')
  assert.equal(room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0), startingTotal)
  room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })
  assert.equal(room.result.room.pokerTable.handSequence, 2)
})

test('ONLINE API settles three-player and six-player contested hands', { skip: !isolated }, async () => {
  for (const count of [3, 6]) {
    const room = await createRoomApi()
    const playerIds = [room.ownerId]
    for (let index = 2; index <= count; index += 1) {
      const player = await join(room, `settlement-${count}-${index}`)
      playerIds.push(player.playerId)
    }
    for (const playerId of playerIds) {
      room.result = await setAuthenticatedOnlineRoomReady(playerId, room.result.room.roomCode, {
        concurrencyToken: room.result.concurrencyToken,
        ready: true
      }, { runtime: room.runtime })
    }
    room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })
    const startingTotal = room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0) + room.result.room.pokerTable.currentHand!.pot
    for (let guard = 0; guard < 150 && room.result.room.pokerTable.currentHand?.street !== 'FINISHED'; guard += 1) {
      const hand = room.result.room.pokerTable.currentHand!
      assert.ok(hand.currentActor !== null)
      const actor = hand.players.find(item => item.seat === hand.currentActor)!
      room.result = await applyAuthenticatedOnlineRoomAction(actor.playerId, room.result.room.roomCode, {
        actionId: `settlement-${count}-${guard}-${randomUUID()}`,
        expectedTableStateVersion: room.result.room.pokerTable.stateVersion,
        action: { type: hand.currentBet > actor.streetContribution ? 'call' : 'check' }
      }, { runtime: room.runtime })
    }
    assert.equal(room.result.room.pokerTable.currentHand?.street, 'FINISHED')
    assert.equal(room.result.room.pokerTable.players.reduce((sum, item) => sum + item.stack, 0), startingTotal)
  }
})

test('ONLINE API recovers an unsettled terminal hand before starting the next hand', { skip: !isolated }, async () => {
  const room = await createRoomApi()
  const player = await join(room, 'recovery-player')
  await readyBoth(room, room.ownerId, player.playerId)
  room.result = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, room.result.room.pokerTable.stateVersion, { runtime: room.runtime })

  const current = await room.runtime.get(room.result.room.roomId)
  assert.ok(current)
  let terminal = current.state.pokerTable
  for (let guard = 0; guard < 100 && terminal.currentHand?.street !== 'SHOWDOWN'; guard += 1) {
    const hand = terminal.currentHand
    assert.ok(hand)
    assert.notEqual(hand.currentActor, null)
    const actor = hand.players.find(item => item.seat === hand.currentActor)!
    terminal = applyTableAction(terminal, {
      playerId: actor.playerId,
      type: getToCall(hand, actor.playerId) > 0 ? 'call' : 'check'
    })
    if (terminal.currentHand?.bettingRoundComplete && terminal.currentHand.street !== 'SHOWDOWN') {
      terminal = advanceTableStreet(terminal)
    }
  }
  assert.equal(terminal.currentHand?.street, 'SHOWDOWN')
  await room.runtime.update(room.result.room.roomId, current.runtimeRevision, state => Object.freeze({
    ...state,
    status: 'IN_HAND' as const,
    pokerTable: terminal
  }))

  const unsettled = await getAuthenticatedOnlineRoom(room.ownerId, room.result.room.roomCode, { runtime: room.runtime })
  const next = await startAuthenticatedOnlineRoomHand(room.ownerId, room.result.room.roomCode, unsettled.room.pokerTable.stateVersion, { runtime: room.runtime })
  assert.equal(next.room.pokerTable.handSequence, 2)
  assert.equal(next.room.pokerTable.currentHand?.street, 'PREFLOP')
})
