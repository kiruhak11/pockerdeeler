import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import {
  activateOnlineBuyIn,
  completeOnlineCashOut,
  prepareOnlineCashOut,
  reserveOnlineBuyIn
} from '../server/services/onlineRoomAccountingService'
import {
  createAuthenticatedOnlineRoom,
  getAuthenticatedOnlineRoom,
  joinAuthenticatedOnlineRoom,
  leaveAuthenticatedOnlineRoom
} from '../server/services/onlineRoomApiService'
import { createPersistentOnlineRoom } from '../server/services/roomCodeRegistryService'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'

const dbUrl = process.env.DATABASE_URL
const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(dbUrl)
const apiIsolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const redis = apiIsolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const users: string[] = []
const rooms: string[] = []
const registries: string[] = []
const runtimePrefixes: string[] = []
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function fixtureCode(prefix: string): string {
  const seed = randomUUID().replaceAll('-', '')
  return prefix + seed.slice(0, 4).split('').map(char => alphabet[Number.parseInt(char, 16) % alphabet.length]).join('')
}

function apiRuntime(): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:online-accounting:${randomUUID()}:`
  runtimePrefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 120 })
}

async function fixture(label: string, balance = 50_000) {
  const user = await db.user.create({
    data: {
      username: `oa_${label}_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      passwordHash: 'test',
      balance,
      wallet: { create: { balance: BigInt(balance) } }
    }
  })
  users.push(user.id)
  const room = await createPersistentOnlineRoom({
    ownerId: user.id,
    visibility: 'PUBLIC',
    startingStack: 10_000,
    codeGenerator: () => fixtureCode('AC')
  })
  rooms.push(room.id)
  registries.push(room.roomCode)
  return { user, room }
}

test('ONLINE buy-in debits canonical wallet exactly once', { skip: !isolated }, async () => {
  const { user, room } = await fixture('buyin')
  const reservation = await reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 })
  assert.equal(reservation.status, 'RESERVING')
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 40_000n)
  assert.equal(await db.walletLedgerEntry.count({ where: { walletId: wallet.id, entryType: 'ONLINE_POKER_BUY_IN' } }), 1)
})

test('insufficient wallet balance rejects the buy-in', { skip: !isolated }, async () => {
  const { user, room } = await fixture('insufficient', 9_999)
  await assert.rejects(reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 }))
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 9_999n)
})

test('exact wallet balance can fund the buy-in', { skip: !isolated }, async () => {
  const { user, room } = await fixture('exact', 10_000)
  const reservation = await reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 })
  assert.equal(reservation.amount, 10_000)
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 0n)
})

test('concurrent duplicate buy-ins create one reservation and one debit', { skip: !isolated }, async () => {
  const { user, room } = await fixture('duplicate')
  const results = await Promise.all([
    reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 }),
    reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 })
  ])
  assert.deepEqual(results.map(result => result.sequence), [0, 0])
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 40_000n)
  assert.equal(await db.onlineRoomPlayer.count({ where: { roomId: room.id, userId: user.id } }), 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { walletId: wallet.id, entryType: 'ONLINE_POKER_BUY_IN' } }), 1)
})

test('cash-out returns the remaining table stack exactly once', { skip: !isolated }, async () => {
  const { user, room } = await fixture('cashout')
  const reservation = await reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 })
  await activateOnlineBuyIn({ roomId: room.id, userId: user.id, sequence: reservation.sequence, seat: 1 })
  assert.equal(await prepareOnlineCashOut({ roomId: room.id, userId: user.id, amount: 7_500 }), true)
  assert.equal(await completeOnlineCashOut({ roomId: room.id, userId: user.id }), true)
  assert.equal(await completeOnlineCashOut({ roomId: room.id, userId: user.id }), false)
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 47_500n)
  assert.equal(await db.walletLedgerEntry.count({ where: { walletId: wallet.id, entryType: 'ONLINE_POKER_CASH_OUT' } }), 1)
})

test('zero-stack cash-out closes the reservation without a zero ledger entry', { skip: !isolated }, async () => {
  const { user, room } = await fixture('zero-cashout')
  const reservation = await reserveOnlineBuyIn({ roomId: room.id, userId: user.id, seat: 1, amount: 10_000 })
  await activateOnlineBuyIn({ roomId: room.id, userId: user.id, sequence: reservation.sequence, seat: 1 })
  assert.equal(await prepareOnlineCashOut({ roomId: room.id, userId: user.id, amount: 0 }), true)
  assert.equal(await completeOnlineCashOut({ roomId: room.id, userId: user.id }), true)
  assert.equal(await completeOnlineCashOut({ roomId: room.id, userId: user.id }), false)
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 40_000n)
  assert.equal(await db.walletLedgerEntry.count({ where: { walletId: wallet.id, entryType: 'ONLINE_POKER_CASH_OUT' } }), 0)
  assert.equal((await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: room.id, userId: user.id } } })).status, 'CASHED_OUT')
})

test('one balance can fund separate rooms only up to the available amount', { skip: !isolated }, async () => {
  const { user, room: first } = await fixture('multiroom', 15_000)
  const second = await createPersistentOnlineRoom({
    ownerId: user.id,
    visibility: 'PUBLIC',
    startingStack: 10_000,
    codeGenerator: () => fixtureCode('BD')
  })
  rooms.push(second.id)
  registries.push(second.roomCode)
  await reserveOnlineBuyIn({ roomId: first.id, userId: user.id, seat: 1, amount: 10_000 })
  await assert.rejects(reserveOnlineBuyIn({ roomId: second.id, userId: user.id, seat: 1, amount: 10_000 }))
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId: user.id } })
  assert.equal(wallet.balance, 5_000n)
})

test('authenticated create, join and leave move real account chips exactly once', { skip: !apiIsolated }, async () => {
  const owner = await db.user.create({
    data: { username: `oa_owner_${randomUUID().replaceAll('-', '').slice(0, 20)}`, passwordHash: 'test', balance: 50_000, wallet: { create: { balance: 50_000n } } }
  })
  const joiner = await db.user.create({
    data: { username: `oa_joiner_${randomUUID().replaceAll('-', '').slice(0, 20)}`, passwordHash: 'test', balance: 20_000, wallet: { create: { balance: 20_000n } } }
  })
  users.push(owner.id, joiner.id)
  await redis!.connect()
  const runtime = apiRuntime()
  const created = await createAuthenticatedOnlineRoom(owner.id, { startingStack: 10_000 }, { runtime })
  rooms.push(created.room.roomId)
  const ownerAfterBuyIn = await db.userWallet.findUniqueOrThrow({ where: { userId: owner.id } })
  assert.equal(ownerAfterBuyIn.balance, 40_000n)
  const joined = await joinAuthenticatedOnlineRoom(joiner.id, created.room.roomCode, { concurrencyToken: created.concurrencyToken }, { runtime })
  const joinerAfterBuyIn = await db.userWallet.findUniqueOrThrow({ where: { userId: joiner.id } })
  assert.equal(joinerAfterBuyIn.balance, 10_000n)
  await assert.rejects(
    joinAuthenticatedOnlineRoom(joiner.id, created.room.roomCode, { concurrencyToken: joined.concurrencyToken }, { runtime }),
    error => error instanceof Error && 'statusCode' in error && (error as { statusCode: number }).statusCode === 409
  )
  const reloaded = await getAuthenticatedOnlineRoom(joiner.id, created.room.roomCode, { runtime })
  assert.equal(reloaded.room.pokerTable.players.find(player => player.playerId === joiner.id)?.stack, 10_000)
  const left = await leaveAuthenticatedOnlineRoom(joiner.id, created.room.roomCode, { concurrencyToken: joined.concurrencyToken }, { runtime })
  assert.equal(left.room.pokerTable.players.some(player => player.playerId === joiner.id), false)
  const joinerAfterCashOut = await db.userWallet.findUniqueOrThrow({ where: { userId: joiner.id } })
  assert.equal(joinerAfterCashOut.balance, 20_000n)
})

test.after(async () => {
  if (!dbUrl) {
    await db.$disconnect()
    return
  }
  if (rooms.length > 0) await db.onlineRoom.deleteMany({ where: { id: { in: rooms } } })
  if (registries.length > 0) await db.roomCodeRegistry.deleteMany({ where: { code: { in: registries } } })
  if (users.length > 0) await db.user.deleteMany({ where: { id: { in: users } } })
  if (apiIsolated) {
    for (const prefix of runtimePrefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length > 0) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
  await db.$disconnect()
})
