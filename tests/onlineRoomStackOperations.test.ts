import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import {
  changeAuthenticatedOnlineStack,
  createAuthenticatedOnlineRoom,
  getAuthenticatedOnlineRoom,
  joinAuthenticatedOnlineRoom,
  leaveAuthenticatedOnlineRoom,
  recoverIncompleteOnlineStackOperations,
  setAuthenticatedOnlineRoomReady,
  startAuthenticatedOnlineRoomHand
} from '../server/services/onlineRoomApiService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { prepareOnlineStackOperation } from '../server/services/onlineRoomAccountingService'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const users: string[] = []
const rooms: string[] = []
const prefixes: string[] = []

function runtime(): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:online-stack:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 120 })
}

const timer = { start() {}, async schedule() {}, async clear() {} } as any

async function account(label: string, balance = 50_000) {
  const user = await db.user.create({ data: {
    username: `os_${label}_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    passwordHash: 'test', balance,
    wallet: { create: { balance: BigInt(balance) } }
  } })
  users.push(user.id)
  return user
}

async function table(label: string, withSecond = false) {
  const owner = await account(`${label}_owner`)
  const store = runtime()
  const created = await createAuthenticatedOnlineRoom(owner.id, { startingStack: 10_000 }, { runtime: store })
  rooms.push(created.room.roomId)
  let player: Awaited<ReturnType<typeof account>> | null = null
  let result = created
  if (withSecond) {
    player = await account(`${label}_player`, 20_000)
    result = await joinAuthenticatedOnlineRoom(player.id, created.room.roomCode, { concurrencyToken: result.concurrencyToken }, { runtime: store })
  }
  return { owner, player, store, result }
}

async function wallet(userId: string): Promise<bigint> {
  return (await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance
}

test.before(async () => { if (isolated && redis!.status === 'wait') await redis!.connect() })

test('stack ADD/WITHDRAW conserve chips, sync reservation and ledger, and replay once', { skip: !isolated }, async () => {
  const { owner, store, result } = await table('roundtrip')
  const addKey = randomUUID()
  const [added, replayAdd] = await Promise.all([
    changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'ADD', amount: 3_000, requestKey: addKey }, { runtime: store }),
    changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'ADD', amount: 3_000, requestKey: addKey }, { runtime: store })
  ])
  assert.equal(added.room.pokerTable.players[0]?.stack, 13_000)
  assert.equal(replayAdd.room.pokerTable.players[0]?.stack, 13_000)
  assert.equal(added.walletBalance, 37_000)
  assert.equal(await wallet(owner.id), 37_000n)
  assert.equal((await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: result.room.roomId, userId: owner.id } } })).buyIn, 13_000n)
  const withdrawKey = randomUUID()
  const [withdrawn, replayWithdraw] = await Promise.all([
    changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 2_000, requestKey: withdrawKey }, { runtime: store }),
    changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 2_000, requestKey: withdrawKey }, { runtime: store })
  ])
  assert.equal(withdrawn.room.pokerTable.players[0]?.stack, 11_000)
  assert.equal(replayWithdraw.room.pokerTable.players[0]?.stack, 11_000)
  assert.equal(await wallet(owner.id), 39_000n)
  assert.equal(withdrawn.walletBalance, 39_000)
  assert.equal((await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: result.room.roomId, userId: owner.id } } })).buyIn, 11_000n)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId: owner.id }, entryType: 'ONLINE_POKER_STACK_ADD' } }), 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId: owner.id }, entryType: 'ONLINE_POKER_STACK_WITHDRAW' } }), 1)
  assert.equal(await db.onlineStackOperation.count({ where: { roomId: result.room.roomId, userId: owner.id, status: 'COMPLETED' } }), 2)
  assert.equal(await wallet(owner.id) + BigInt(withdrawn.room.pokerTable.players[0]!.stack), 50_000n)
})

test('insufficient ADD, over-stack/full-stack withdrawal, spectator and active-hand changes reject safely', { skip: !isolated }, async () => {
  const { owner, store, result } = await table('validation')
  const spectator = await account('spectator', 5_000)
  const startWallet = await wallet(owner.id)
  await assert.rejects(changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'ADD', amount: 40_001, requestKey: randomUUID() }, { runtime: store }))
  await assert.rejects(changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 10_001, requestKey: randomUUID() }, { runtime: store }))
  await assert.rejects(changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 10_000, requestKey: randomUUID() }, { runtime: store }))
  await assert.rejects(changeAuthenticatedOnlineStack(spectator.id, result.room.roomCode, { direction: 'ADD', amount: 1, requestKey: randomUUID() }, { runtime: store }))
  assert.equal(await wallet(owner.id), startWallet)
  assert.equal(await wallet(spectator.id), 5_000n)
  assert.equal(await db.onlineStackOperation.count({ where: { roomId: result.room.roomId, userId: spectator.id } }), 0)

  const joined = await table('active', true)
  const player = joined.player!
  let state = await setAuthenticatedOnlineRoomReady(joined.owner.id, joined.result.room.roomCode, { concurrencyToken: joined.result.concurrencyToken, ready: true }, { runtime: joined.store })
  state = await setAuthenticatedOnlineRoomReady(player.id, joined.result.room.roomCode, { concurrencyToken: state.concurrencyToken, ready: true }, { runtime: joined.store })
  const hand = await startAuthenticatedOnlineRoomHand(joined.owner.id, joined.result.room.roomCode, state.room.pokerTable.stateVersion, { runtime: joined.store, timer })
  assert.ok(hand.room.pokerTable.currentHand)
  await assert.rejects(changeAuthenticatedOnlineStack(joined.owner.id, joined.result.room.roomCode, { direction: 'ADD', amount: 1, requestKey: randomUUID() }, { runtime: joined.store }))
  await assert.rejects(changeAuthenticatedOnlineStack(player.id, joined.result.room.roomCode, { direction: 'WITHDRAW', amount: 1, requestKey: randomUUID() }, { runtime: joined.store }))
  assert.equal(await db.onlineStackOperation.count({ where: { roomId: joined.result.room.roomId, status: { not: 'COMPLETED' } } }), 0)
})

test('DB-committed ADD recovers after a crash before Redis and remains idempotent', { skip: !isolated }, async () => {
  const { owner, store, result } = await table('add-recovery')
  const requestKey = randomUUID()
  const operation = await prepareOnlineStackOperation({
    roomId: result.room.roomId, userId: owner.id, requestKey, direction: 'ADD', amount: 1_500,
    readRuntime: async () => {
      const current = await store.get(result.room.roomId)
      return { stack: current?.state.pokerTable.players.find(player => player.playerId === owner.id)?.stack ?? null, activeHand: false }
    }
  })
  assert.equal(operation.status, 'PREPARED')
  assert.equal(await wallet(owner.id), 38_500n)
  assert.equal(await recoverIncompleteOnlineStackOperations({ runtime: store }), 1)
  const recovered = await getAuthenticatedOnlineRoom(owner.id, result.room.roomCode, { runtime: store })
  assert.equal(recovered.room.pokerTable.players[0]?.stack, 11_500)
  await getAuthenticatedOnlineRoom(owner.id, result.room.roomCode, { runtime: store })
  assert.equal(await wallet(owner.id), 38_500n)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId: owner.id }, entryType: 'ONLINE_POKER_STACK_ADD' } }), 1)
  assert.equal((await db.onlineStackOperation.findUniqueOrThrow({ where: { id: operation.id } })).status, 'COMPLETED')
})

test('WITHDRAW recovers a Redis success with lost response before DB credit; retry uses the same request key', { skip: !isolated }, async () => {
  const { owner, store, result } = await table('withdraw-recovery')
  const requestKey = randomUUID()
  const original = store.updateWithAction.bind(store)
  let loseAck = true
  ;(store as any).updateWithAction = async (...args: any[]) => {
    const applied = await (original as any)(...args)
    if (loseAck) { loseAck = false; throw new Error('injected lost Redis response') }
    return applied
  }
  await assert.rejects(changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 2_500, requestKey }, { runtime: store }))
  assert.equal(await wallet(owner.id), 40_000n)
  const recovered = await getAuthenticatedOnlineRoom(owner.id, result.room.roomCode, { runtime: store })
  assert.equal(recovered.room.pokerTable.players[0]?.stack, 7_500)
  const retried = await changeAuthenticatedOnlineStack(owner.id, result.room.roomCode, { direction: 'WITHDRAW', amount: 2_500, requestKey }, { runtime: store })
  assert.equal(retried.room.pokerTable.players[0]?.stack, 7_500)
  assert.equal(await wallet(owner.id), 42_500n)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId: owner.id }, entryType: 'ONLINE_POKER_STACK_WITHDRAW' } }), 1)
  assert.equal(await db.onlineStackOperation.count({ where: { roomId: result.room.roomId, requestKey, status: 'COMPLETED' } }), 1)
})

test('stack operation racing hand start or leave is serialized and preserves final accounting', { skip: !isolated }, async () => {
  const joined = await table('race', true)
  const player = joined.player!
  let ready = await setAuthenticatedOnlineRoomReady(joined.owner.id, joined.result.room.roomCode, { concurrencyToken: joined.result.concurrencyToken, ready: true }, { runtime: joined.store })
  ready = await setAuthenticatedOnlineRoomReady(player.id, joined.result.room.roomCode, { concurrencyToken: ready.concurrencyToken, ready: true }, { runtime: joined.store })
  const before = ready.room.pokerTable.stateVersion
  const attempts = await Promise.allSettled([
    changeAuthenticatedOnlineStack(player.id, joined.result.room.roomCode, { direction: 'ADD', amount: 1_000, requestKey: randomUUID() }, { runtime: joined.store }),
    startAuthenticatedOnlineRoomHand(joined.owner.id, joined.result.room.roomCode, before, { runtime: joined.store, timer })
  ])
  const final = await getAuthenticatedOnlineRoom(player.id, joined.result.room.roomCode, { runtime: joined.store })
  if (final.room.pokerTable.currentHand) {
    const tableStack = final.room.pokerTable.players.find(candidate => candidate.playerId === player.id)?.stack
    const handStack = final.room.pokerTable.currentHand.players.find(candidate => candidate.playerId === player.id)?.stack
    assert.equal(handStack, tableStack)
  }
  assert.ok(attempts.some(item => item.status === 'fulfilled'))

  const stackBeforeLeave = final.room.pokerTable.players.find(candidate => candidate.playerId === player.id)?.stack ?? 0
  if (!final.room.pokerTable.currentHand) {
    const concurrent = await Promise.allSettled([
      changeAuthenticatedOnlineStack(player.id, joined.result.room.roomCode, { direction: 'WITHDRAW', amount: 1_000, requestKey: randomUUID() }, { runtime: joined.store }),
      leaveAuthenticatedOnlineRoom(player.id, joined.result.room.roomCode, { concurrencyToken: final.concurrencyToken }, { runtime: joined.store })
    ])
    const afterLeave = await getAuthenticatedOnlineRoom(joined.owner.id, joined.result.room.roomCode, { runtime: joined.store }).catch(() => null)
    const reservation = await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: joined.result.room.roomId, userId: player.id } } })
    if (reservation.status === 'CASHED_OUT') {
      assert.equal(await wallet(player.id), 20_000n)
    } else {
      assert.ok(concurrent.some(item => item.status === 'rejected'))
      assert.ok(afterLeave)
      assert.ok(stackBeforeLeave > 0)
    }
  }

  const leaveRace = await table('leave-race', true)
  const leavingPlayer = leaveRace.player!
  const noHand = await getAuthenticatedOnlineRoom(leavingPlayer.id, leaveRace.result.room.roomCode, { runtime: leaveRace.store })
  const concurrent = await Promise.allSettled([
    changeAuthenticatedOnlineStack(leavingPlayer.id, leaveRace.result.room.roomCode, { direction: 'WITHDRAW', amount: 1_000, requestKey: randomUUID() }, { runtime: leaveRace.store }),
    leaveAuthenticatedOnlineRoom(leavingPlayer.id, leaveRace.result.room.roomCode, { concurrencyToken: noHand.concurrencyToken }, { runtime: leaveRace.store })
  ])
  const reservation = await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: leaveRace.result.room.roomId, userId: leavingPlayer.id } } })
  assert.ok(concurrent.some(item => item.status === 'fulfilled'))
  if (reservation.status === 'CASHED_OUT') assert.equal(await wallet(leavingPlayer.id), 20_000n)
  else {
    assert.ok(concurrent.some(item => item.status === 'rejected'))
    const after = await getAuthenticatedOnlineRoom(leavingPlayer.id, leaveRace.result.room.roomCode, { runtime: leaveRace.store })
    assert.equal(after.room.pokerTable.players.find(item => item.playerId === leavingPlayer.id)?.stack, 9_000)
    assert.equal(await wallet(leavingPlayer.id) + 9_000n, 20_000n)
  }
})

test.after(async () => {
  if (rooms.length > 0) await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: rooms } } })
  if (rooms.length > 0) await db.onlineRoom.deleteMany({ where: { id: { in: rooms } } })
  if (users.length > 0) await db.user.deleteMany({ where: { id: { in: users } } })
  if (isolated) {
    for (const prefix of prefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
  await db.$disconnect()
})
