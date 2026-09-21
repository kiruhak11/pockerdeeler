import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { createRoom } from '../server/services/roomService'
import { createPersistentOnlineRoom, resolveRoomCode } from '../server/services/roomCodeRegistryService'
import { generateOnlineRoomCode } from '../server/utils/pokerOnlineRoom'
import { hashSecret } from '../server/services/authService'

const dbUrl = process.env.DATABASE_URL
const db = new PrismaClient()
const onlineIds: string[] = []
const homeIds: string[] = []

async function createOnline(code: string, extra: Record<string, unknown> = {}) {
  const room = await createPersistentOnlineRoom({
    ownerId: `owner-${generateOnlineRoomCode(6)}`,
    visibility: 'PUBLIC',
    codeGenerator: () => code,
    maxAttempts: 1,
    ...extra
  })
  onlineIds.push(room.id)
  return room
}

async function createHome() {
  const result = await createRoom({
    name: `Registry test ${generateOnlineRoomCode(6)}`,
    startingStack: 1000,
    maxPlayers: 6,
    allowLateJoin: true,
    requireDealerActionApproval: false,
    allowSpectators: true
  }, 'http://test')
  const row = await db.room.findUniqueOrThrow({ where: { code: result.roomCode } })
  homeIds.push(row.id)
  return row
}

test('persistent room tests require the isolated PostgreSQL test database', { skip: !dbUrl }, async () => {
  assert.ok(dbUrl)
})

test('HOME codes remain unchanged and resolve through the global namespace', { skip: !dbUrl }, async () => {
  const home = await createHome()
  const resolution = await resolveRoomCode(home.code.toLowerCase())
  assert.equal(home.code, home.code.toUpperCase())
  assert.deepEqual(resolution, { normalizedCode: home.code, roomType: 'HOME', targetId: home.id })
  const registry = await db.roomCodeRegistry.findUnique({ where: { code: home.code } })
  assert.deepEqual(registry && { code: registry.code, roomType: registry.roomType, targetId: registry.targetId }, {
    code: home.code,
    roomType: 'HOME',
    targetId: home.id
  })
})

test('new ONLINE metadata and registry claim are created atomically', { skip: !dbUrl }, async () => {
  const code = generateOnlineRoomCode()
  const room = await createOnline(code)
  assert.equal(room.roomCode, code)
  const metadata = await db.onlineRoom.findUniqueOrThrow({ where: { id: room.id } })
  const registry = await db.roomCodeRegistry.findUniqueOrThrow({ where: { code } })
  assert.equal(metadata.roomCode, code)
  assert.equal(metadata.maxPlayers, 6)
  assert.equal(registry.roomType, 'ONLINE')
  assert.equal(registry.targetId, room.id)
})

test('HOME and ONLINE collision retries with a new candidate', { skip: !dbUrl }, async () => {
  const home = await createHome()
  const retryCode = generateOnlineRoomCode()
  const candidates = [home.code.toLowerCase(), retryCode]
  const room = await createPersistentOnlineRoom({
    ownerId: 'collision-retry-owner',
    visibility: 'PUBLIC',
    codeGenerator: () => candidates.shift() ?? retryCode
  })
  onlineIds.push(room.id)
  assert.equal(room.roomCode, retryCode)
  assert.equal(await db.onlineRoom.count({ where: { roomCode: home.code } }), 0)
})

test('ONLINE code collision retries without creating a duplicate metadata row', { skip: !dbUrl }, async () => {
  const firstCode = generateOnlineRoomCode()
  await createOnline(firstCode)
  const retryCode = generateOnlineRoomCode()
  const candidates = [firstCode, retryCode]
  const second = await createPersistentOnlineRoom({
    ownerId: 'online-collision-owner',
    visibility: 'PUBLIC',
    codeGenerator: () => candidates.shift() ?? retryCode
  })
  onlineIds.push(second.id)
  assert.equal(second.roomCode, retryCode)
  assert.equal(await db.onlineRoom.count({ where: { roomCode: firstCode } }), 1)
})

test('concurrent identical candidate claims allow only one ONLINE room', { skip: !dbUrl }, async () => {
  const code = generateOnlineRoomCode()
  const results = await Promise.allSettled([
    createPersistentOnlineRoom({ ownerId: 'concurrent-owner-a', visibility: 'PUBLIC', codeGenerator: () => code, maxAttempts: 1 }),
    createPersistentOnlineRoom({ ownerId: 'concurrent-owner-b', visibility: 'PUBLIC', codeGenerator: () => code, maxAttempts: 1 })
  ])
  const fulfilled = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  if (fulfilled[0]?.status === 'fulfilled') onlineIds.push(fulfilled[0].value.id)
  assert.equal(await db.roomCodeRegistry.count({ where: { code } }), 1)
  assert.equal(await db.onlineRoom.count({ where: { roomCode: code } }), 1)
})

test('collision failure rolls back metadata and leaves no orphan ONLINE row', { skip: !dbUrl }, async () => {
  const home = await createHome()
  await assert.rejects(createPersistentOnlineRoom({
    ownerId: 'rollback-owner',
    visibility: 'PUBLIC',
    codeGenerator: () => home.code,
    maxAttempts: 2
  }), /Unable to claim a unique online room code/)
  assert.equal(await db.onlineRoom.count({ where: { ownerId: 'rollback-owner' } }), 0)
  assert.equal(await db.roomCodeRegistry.count({ where: { code: home.code, roomType: 'ONLINE' } }), 0)
})

test('private metadata stores only a hash and resolver returns no authorization data', { skip: !dbUrl }, async () => {
  const code = generateOnlineRoomCode()
  const secretHash = hashSecret('persistent-private-secret')
  const room = await createPersistentOnlineRoom({
    ownerId: 'private-owner',
    visibility: 'PRIVATE',
    privateJoinSecretHash: secretHash,
    codeGenerator: () => code,
    maxAttempts: 1
  })
  onlineIds.push(room.id)
  const stored = await db.onlineRoom.findUniqueOrThrow({ where: { id: room.id } })
  assert.equal(stored.privateJoinSecretHash, secretHash)
  assert.deepEqual(Object.keys((await resolveRoomCode(code))!).sort(), ['normalizedCode', 'roomType', 'targetId'])
})

test('lowercase input resolves and invalid codes are rejected', { skip: !dbUrl }, async () => {
  const code = generateOnlineRoomCode()
  const room = await createOnline(code.toLowerCase())
  assert.equal((await resolveRoomCode(code.toLowerCase()))!.targetId, room.id)
  await assert.rejects(createPersistentOnlineRoom({ ownerId: 'invalid-owner', visibility: 'PUBLIC', codeGenerator: () => '0OIl!!', maxAttempts: 1 }), /Room code/)
})

test('unknown code resolves to NOT_FOUND', { skip: !dbUrl }, async () => {
  assert.equal(await resolveRoomCode(generateOnlineRoomCode()), null)
})

test('closed ONLINE metadata remains resolvable and its code is not reusable', { skip: !dbUrl }, async () => {
  const code = generateOnlineRoomCode()
  const room = await createOnline(code)
  await db.onlineRoom.update({ where: { id: room.id }, data: { status: 'CLOSED' } })
  assert.deepEqual(await resolveRoomCode(code), { normalizedCode: code, roomType: 'ONLINE', targetId: room.id })
  await assert.rejects(createPersistentOnlineRoom({ ownerId: 'reuse-owner', visibility: 'PUBLIC', codeGenerator: () => code, maxAttempts: 1 }), /Unable to claim a unique online room code/)
})

test.after(async () => {
  if (!dbUrl) {
    await db.$disconnect()
    return
  }
  await db.onlineRoom.deleteMany({ where: { id: { in: onlineIds } } })
  await db.room.deleteMany({ where: { id: { in: homeIds } } })
  await db.$disconnect()
})
