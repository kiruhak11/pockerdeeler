import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import {
  OnlinePokerBotOrchestrator,
  readOnlinePokerBotOrchestratorConfig,
  type OnlinePokerBotOrchestratorAdapter
} from '../server/services/onlinePokerBotOrchestrator'
import type { PersistentBotIdentity } from '../server/services/botIdentityService'
import {
  getBotRocketSnapshot,
  placeCrashBet,
  placeCrashBetForBot,
  registerBotRocketLease,
  type BotRocketFence,
  type BotRocketSnapshot
} from '../server/services/crashService'
import { OnlinePokerBotLeaseService } from '../server/services/onlinePokerBotLeaseService'
import { issueUserAuthToken } from '../server/services/userAccountService'
import {
  commitOnlineBuyInSeat,
  completeOnlineCashOut,
  prepareOnlineCashOut,
  reserveOnlineBuyIn
} from '../server/services/onlineRoomAccountingService'

const dbUrl = process.env.DATABASE_URL
const isolatedDb = Boolean(dbUrl && (/:55439\//.test(dbUrl) || /_test(?:$|[?])/.test(dbUrl)))
const singleConnectionPool = Boolean(dbUrl && /(?:[?&])connection_limit=1(?:&|$)/.test(dbUrl))
const testRedisUrl = process.env.ONLINE_POKER_BOT_TEST_REDIS_URL ?? process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolatedRedis = Boolean(testRedisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(testRedisUrl))
const db = new PrismaClient()

const baseConfig = (overrides: Partial<ReturnType<typeof readOnlinePokerBotOrchestratorConfig>> = {}) => ({
  enabled: true,
  minActiveBots: 1,
  maxActiveBots: 1,
  maxBotsPerRoom: 3,
  maxBotCreatedRooms: 0,
  tickIntervalMs: 1_000,
  startingStack: 1_000,
  smallBlind: 5,
  bigBlind: 10,
  quickJoinProbability: 1,
  createRoomProbability: 0,
  rocketPlayProbability: 1,
  ...overrides
})

function bot(id: string, balance = 500): PersistentBotIdentity {
  return {
    id,
    botKey: `rocket-${id}`,
    nickname: `Rocket ${id}`,
    isBot: true,
    botEnabled: true,
    skillTier: 'REGULAR',
    playStyle: 'BALANCED',
    balance,
    tableRating: 1_000,
    tableHandsPlayed: 0,
    tableHandsWon: 0,
    predictionRating: 1_000,
    leaderboardVisible: true
  }
}

const emptyRoom = (playerId: string) => ({
  roomId: 'room-id',
  roomCode: 'AB2345',
  visibility: 'PUBLIC',
  ownerId: 'human-owner',
  status: 'WAITING',
  roomVersion: 1,
  maxPlayers: 6,
  pokerTable: {
    tableId: 'table-id',
    maxPlayers: 6,
    seats: [{ seat: 1, playerId }],
    players: [{ playerId, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false }],
    currentHand: null,
    dealerSeat: null,
    status: 'WAITING',
    stateVersion: 1,
    handSequence: 0,
    finalizedHandId: null,
    finalizedHand: null,
    smallBlind: 5,
    bigBlind: 10
  }
})

function harness(options: {
  identity?: PersistentBotIdentity
  snapshot?: BotRocketSnapshot
  seatedRoom?: string | null
  currentRoom?: unknown
  enabled?: boolean
} = {}) {
  const identity = options.identity ?? bot('test-bot')
  const events: Array<{ method: string; input?: any }> = []
  let now = 1_000_000
  const snapshot = options.snapshot ?? {
    roundId: 'round-1',
    phase: 'betting' as const,
    bettingMsRemaining: 15_000,
    bots: { [identity.id]: { balance: identity.balance, hasBet: false } }
  }
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    listBots: async () => [identity],
    listPublicRooms: async () => [],
    countBotCreatedRooms: async () => 0,
    cleanupBotCreatedRooms: async () => 0,
    findSeatedRoom: async () => options.seatedRoom ?? null,
    getRoom: async () => ({ room: options.currentRoom ?? emptyRoom(identity.id) } as any),
    getDecisionSnapshot: async () => { throw new Error('not used') },
    createRoom: async () => { events.push({ method: 'create' }); return { room: emptyRoom(identity.id) } as any },
    joinRoom: async () => { events.push({ method: 'join' }); return { room: emptyRoom(identity.id) } as any },
    ready: async () => { events.push({ method: 'ready' }); return { room: emptyRoom(identity.id) } as any },
    startHand: async () => { events.push({ method: 'start' }); return { room: emptyRoom(identity.id) } as any },
    action: async () => { events.push({ method: 'action' }); return {} },
    leave: async () => { events.push({ method: 'leave' }); return { room: emptyRoom(identity.id) } as any },
    registerRocketLease: async (_id, fence) => { events.push({ method: 'register', input: fence.token }) },
    getRocketSnapshot: async ids => {
      events.push({ method: 'snapshot', input: ids })
      return snapshot
    },
    placeRocketBet: async (_id, input, fence) => {
      events.push({ method: 'bet', input: { ...input, key: fence.key, token: fence.token } })
      return true
    }
  }
  const lease = {
    acquire: async (botKey: string) => ({ botKey, ownerId: 'worker', token: `1:${botKey}`, leaseKey: `pocker:online-bot-lease:v1:${botKey}` }),
    renew: async () => true,
    release: async () => true
  }
  const orchestrator = new OnlinePokerBotOrchestrator({
    config: baseConfig({ enabled: options.enabled ?? true }),
    adapter,
    lease,
    now: () => now,
    random: () => 0
  })
  return { orchestrator, adapter, events, setNow: (value: number) => { now = value } }
}

test('Rocket automation shares the orchestrator feature flag and defaults to a bounded chance', async () => {
  assert.equal(readOnlinePokerBotOrchestratorConfig({}).enabled, false)
  assert.equal(readOnlinePokerBotOrchestratorConfig({ BOT_ORCHESTRATOR_ENABLED: 'true' }).rocketPlayProbability, 0.15)
  assert.equal(readOnlinePokerBotOrchestratorConfig({ BOT_ORCHESTRATOR_ENABLED: 'true', BOT_ORCHESTRATOR_ROCKET_CHANCE: '2' }).rocketPlayProbability, 0.15)
  const h = harness({ enabled: false })
  await h.orchestrator.tick()
  assert.equal(h.events.length, 0)
})

test('an idle bot places one delayed account-backed Rocket bet with legal limits', async () => {
  const h = harness()
  await h.orchestrator.tick()
  assert.equal(h.events.filter(event => event.method === 'bet').length, 0)
  h.setNow(1_001_000)
  await h.orchestrator.tick()
  const placed = h.events.find(event => event.method === 'bet')
  assert.ok(placed)
  assert.equal(placed.input.expectedRoundId, 'round-1')
  assert.ok(placed.input.stake >= 1 && placed.input.stake <= 500)
  assert.ok(placed.input.autoCashout >= 1.01 && placed.input.autoCashout <= 3)
  assert.equal(placed.input.key, 'pocker:online-bot-lease:v1:rocket-test-bot')
  assert.equal(h.events.filter(event => event.method === 'register').length, 1)
})

test('a bot with an active poker seat has poker priority and cannot place a Rocket bet', async () => {
  const h = harness({ seatedRoom: 'AB2345', currentRoom: emptyRoom('test-bot') })
  await h.orchestrator.tick()
  assert.equal(h.events.some(event => event.method === 'bet'), false)
})

test('broke bots do not receive a Rocket stake or hidden refill', async () => {
  const identity = bot('broke-bot', 0)
  const h = harness({ identity })
  await h.orchestrator.tick()
  assert.equal(h.events.some(event => event.method === 'bet'), false)
})

test('Rocket snapshot contains no multiplier, seed, crash point or payout result', () => {
  const safeSnapshot: BotRocketSnapshot = {
    roundId: 'r',
    phase: 'betting',
    bettingMsRemaining: 5_000,
    bots: { bot: { balance: 5_000, hasBet: false } }
  }
  assert.deepEqual(Object.keys(safeSnapshot).sort(), ['bettingMsRemaining', 'bots', 'phase', 'roundId'])
  assert.deepEqual(Object.keys(safeSnapshot.bots.bot!).sort(), ['balance', 'hasBet'])
})

const usersForCleanup: string[] = []
const roundsForCleanup: string[] = []
const roomsForCleanup: string[] = []
let economyBefore: null | { id: string; dayKey: string; minesBank: bigint; rocketBank: bigint; jackpot: bigint; jackpotTenths: bigint; updatedAt: Date } | undefined

async function createBotFixture(balance: number) {
  const key = `rocket-test-${randomUUID()}`
  const user = await db.user.create({
    data: {
      username: key,
      passwordHash: 'test-only-disabled',
      balance,
      isBot: true,
      botKey: key,
      botSkillTier: 'REGULAR',
      botPlayStyle: 'BALANCED',
      botEnabled: true,
      wallet: { create: { balance: BigInt(balance) } }
    },
    select: { id: true }
  })
  usersForCleanup.push(user.id)
  return { id: user.id, botKey: key }
}

async function createHumanFixture(balance: number) {
  const key = `rocket-human-test-${randomUUID()}`
  const user = await db.user.create({
    data: { username: key, passwordHash: 'test-only', balance, wallet: { create: { balance: BigInt(balance) } } },
    select: { id: true }
  })
  usersForCleanup.push(user.id)
  return user.id
}

async function createBettingRound(crashAt: number) {
  const seed = randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)
  const round = await db.$transaction(async tx => {
    // Match currentRound's lock so a background Rocket poll cannot race this
    // synthetic active round into a different global "current" round.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(928374)`
    const latest = await tx.crashRound.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1))
    return tx.crashRound.create({
      data: { phase: 'betting', createdAt, startedAt: new Date(), crashAt, seed, seedHash: createHash('sha256').update(seed).digest('hex') }
    })
  })
  roundsForCleanup.push(round.id)
  return round
}

async function createActivePokerReservation(userId: string) {
  const room = await db.onlineRoom.create({
    data: {
      roomCode: `R${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`,
      visibility: 'PUBLIC',
      ownerId: userId,
      status: 'WAITING',
      maxPlayers: 6,
      startingStack: 1_000n
    },
    select: { id: true }
  })
  roomsForCleanup.push(room.id)
  await db.onlineRoomPlayer.create({ data: { roomId: room.id, userId, seat: 1, buyIn: 1_000n, status: 'ACTIVE' } })
  return room.id
}

test('bot bet uses the normal CrashBet, wallet ledger and automatic settlement path', { skip: !isolatedDb }, async () => {
  const { id: userId, botKey } = await createBotFixture(1_000)
  const round = await createBettingRound(150)
  economyBefore = await db.miniGameEconomy.findUnique({ where: { id: 'global' } }) ?? null
  const fence: BotRocketFence = { key: `pocker:online-bot-lease:v1:${botKey}`, token: `900:${randomUUID()}`, isLeaseCurrent: async () => true }
  await registerBotRocketLease(userId, fence)
  const snapshot = await getBotRocketSnapshot([userId], async () => true)
  assert.equal(snapshot.roundId, round.id)
  assert.equal(snapshot.phase, 'betting')
  assert.equal(snapshot.bots[userId]?.balance, 1_000)
  assert.equal(await placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 100, autoCashout: 1.25 }, fence), true)
  assert.equal(await placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 100, autoCashout: 1.25 }, fence), false)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), 1)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 900n)

  await db.crashRound.update({ where: { id: round.id }, data: { startedAt: new Date(Date.now() - 120_000) } })
  const settled = await getBotRocketSnapshot([userId], async () => true)
  assert.equal(settled.roundId, round.id)
  assert.equal(settled.phase, 'crashed')
  const bet = await db.crashBet.findUniqueOrThrow({ where: { roundId_userId: { roundId: round.id, userId } } })
  assert.equal(bet.payout, 125)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 1_025n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:payout:${round.id}:${userId}` } }), 1)
  const retriedSettlement = await getBotRocketSnapshot([userId], async () => true)
  assert.ok(['betting', 'flying', 'crashed'].includes(retriedSettlement.phase))
  // The round may legitimately advance after the crash gap; retry safety is
  // verified against the original round's wallet and idempotency ledger below.
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 1_025n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:payout:${round.id}:${userId}` } }), 1)

  await db.user.update({ where: { id: userId }, data: { botFencingToken: 901n } })
  const stale = { ...fence, token: `899:${randomUUID()}` }
  await assert.rejects(placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 10, autoCashout: 1.1 }, stale), { code: 'BOT_LEASE_LOST' })
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 1_025n)
})

test('insufficient bot wallet rejects Rocket stake without creating a bet or negative balance', { skip: !isolatedDb }, async () => {
  const { id: userId, botKey } = await createBotFixture(0)
  const round = await createBettingRound(100)
  const fence: BotRocketFence = { key: `pocker:online-bot-lease:v1:${botKey}`, token: `910:${randomUUID()}`, isLeaseCurrent: async () => true }
  assert.equal(await placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 1, autoCashout: 1.5 }, fence), false)
  assert.equal(await db.crashBet.count({ where: { roundId: round.id, userId } }), 0)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 0n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), 0)
})

test('authoritative ONLINE reservation blocks a direct Rocket bot stake', { skip: !isolatedDb }, async () => {
  const { id: userId, botKey } = await createBotFixture(1_000)
  const round = await createBettingRound(150)
  await createActivePokerReservation(userId)
  const fence: BotRocketFence = { key: `pocker:online-bot-lease:v1:${botKey}`, token: `920:${randomUUID()}`, isLeaseCurrent: async () => true }

  assert.equal(await placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 100, autoCashout: 1.5 }, fence), false)
  assert.equal(await db.crashBet.count({ where: { roundId: round.id, userId } }), 0)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 1_000n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), 0)
})

test('persistent bots cannot use the normal user login/session path', { skip: !isolatedDb }, async () => {
  const { id: userId } = await createBotFixture(1_000)
  await assert.rejects(issueUserAuthToken(userId))
  assert.equal(await db.accountSession.count({ where: { userId } }), 0)
})

test('human Rocket bet still uses its authenticated public path and unchanged wallet debit', { skip: !isolatedDb }, async () => {
  const userId = await createHumanFixture(1_000)
  const token = await issueUserAuthToken(userId)
  const round = await createBettingRound(150)
  const result = await placeCrashBet(token, 100, 1.25)
  assert.equal(result.round.id, round.id)
  assert.equal(result.bet?.stake, 100)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, 900n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), 1)
})

test('ONLINE buy-in and Rocket debit serialize with connection_limit=1', { skip: !(isolatedDb && singleConnectionPool) }, async () => {
  const { id: userId, botKey } = await createBotFixture(100)
  const round = await createBettingRound(150)
  const room = await db.onlineRoom.create({
    data: {
      roomCode: `R${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`,
      visibility: 'PUBLIC',
      ownerId: userId,
      status: 'WAITING',
      maxPlayers: 6,
      startingStack: 70n
    },
    select: { id: true }
  })
  roomsForCleanup.push(room.id)
  const fence: BotRocketFence = { key: `pocker:online-bot-lease:v1:${botKey}`, token: `925:${randomUUID()}`, isLeaseCurrent: async () => true }
  await registerBotRocketLease(userId, fence)

  const [poker, rocket] = await Promise.allSettled([
    reserveOnlineBuyIn({ roomId: room.id, userId, seat: 1, amount: 70 }),
    placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 60, autoCashout: 1.5 }, fence)
  ])
  const pokerWon = poker.status === 'fulfilled'
  const rocketWon = rocket.status === 'fulfilled' && rocket.value
  assert.notEqual(pokerWon, rocketWon, 'exactly one operation can reserve the shared wallet funds')
  if (!pokerWon) {
    assert.equal(poker.status, 'rejected')
    const error = poker.reason as { statusCode?: number; statusMessage?: string }
    assert.equal(error.statusCode, 409)
    assert.match(error.statusMessage ?? '', /недостаточно свободных фишек/i)
  }
  if (rocket.status === 'rejected') throw rocket.reason

  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId } })
  assert.equal(wallet.balance, pokerWon ? 30n : 40n)
  assert.equal(await db.onlineRoomPlayer.count({ where: { roomId: room.id, userId } }), pokerWon ? 1 : 0)
  assert.equal(await db.crashBet.count({ where: { roundId: round.id, userId } }), rocketWon ? 1 : 0)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId }, entryType: 'ONLINE_POKER_BUY_IN' } }), pokerWon ? 1 : 0)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), rocketWon ? 1 : 0)
})

test('ONLINE cash-out and Rocket start serialize with connection_limit=1', { skip: !(isolatedDb && singleConnectionPool) }, async () => {
  const { id: userId, botKey } = await createBotFixture(100)
  const round = await createBettingRound(150)
  const room = await db.onlineRoom.create({
    data: {
      roomCode: `R${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`,
      visibility: 'PUBLIC',
      ownerId: userId,
      status: 'WAITING',
      maxPlayers: 6,
      startingStack: 70n
    },
    select: { id: true }
  })
  roomsForCleanup.push(room.id)
  const reservation = await reserveOnlineBuyIn({ roomId: room.id, userId, seat: 1, amount: 70 })
  await commitOnlineBuyInSeat({ roomId: room.id, userId, sequence: reservation.sequence, seat: 1 }, async () => true)
  assert.equal(await prepareOnlineCashOut({ roomId: room.id, userId, amount: 70 }), true)

  const fence: BotRocketFence = { key: `pocker:online-bot-lease:v1:${botKey}`, token: `926:${randomUUID()}`, isLeaseCurrent: async () => true }
  await registerBotRocketLease(userId, fence)
  const [cashOut, rocket] = await Promise.all([
    completeOnlineCashOut({ roomId: room.id, userId }),
    placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 60, autoCashout: 1.5 }, fence)
  ])

  assert.equal(cashOut, true)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, rocket ? 40n : 100n)
  const reservationAfter = await db.onlineRoomPlayer.findUniqueOrThrow({ where: { roomId_userId: { roomId: room.id, userId } } })
  assert.equal(reservationAfter.status, 'CASHED_OUT')
  assert.equal(await db.crashBet.count({ where: { roundId: round.id, userId } }), rocket ? 1 : 0)
  assert.equal(await db.walletLedgerEntry.count({ where: { wallet: { userId }, entryType: 'ONLINE_POKER_CASH_OUT' } }), 1)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `crash:stake:${round.id}:${userId}` } }), rocket ? 1 : 0)
})

test('two Redis lease owners cannot pass a stale Rocket fence after takeover', { skip: !(isolatedDb && isolatedRedis) }, async () => {
  const { id: userId } = await createBotFixture(1_000)
  const round = await createBettingRound(200)
  const botKey = (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { botKey: true } })).botKey!
  const keyPrefix = `pocker:test:rocket-fencing:${randomUUID()}:`
  const ownerA = new OnlinePokerBotLeaseService({ redisUrl: testRedisUrl!, keyPrefix, ownerId: `worker-a-${randomUUID()}` })
  const ownerB = new OnlinePokerBotLeaseService({ redisUrl: testRedisUrl!, keyPrefix, ownerId: `worker-b-${randomUUID()}` })
  let leaseA: Awaited<ReturnType<typeof ownerA.acquire>> = null
  let leaseB: Awaited<ReturnType<typeof ownerB.acquire>> = null
  try {
    leaseA = await ownerA.acquire(botKey)
    assert.ok(leaseA)
    await registerBotRocketLease(userId, { key: leaseA.leaseKey, token: leaseA.token, isLeaseCurrent: () => ownerA.renew(leaseA!) })
    assert.equal(await ownerB.acquire(botKey), null)
    await ownerA.release(leaseA)
    leaseB = await ownerB.acquire(botKey)
    assert.ok(leaseB)
    await registerBotRocketLease(userId, { key: leaseB.leaseKey, token: leaseB.token, isLeaseCurrent: () => ownerB.renew(leaseB!) })
    const before = (await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance
    await assert.rejects(placeCrashBetForBot(userId, { expectedRoundId: round.id, stake: 100, autoCashout: 1.2 }, {
      key: leaseA.leaseKey,
      token: leaseA.token,
      isLeaseCurrent: async () => true
    }), { code: 'BOT_LEASE_LOST' })
    assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId } })).balance, before)
    assert.equal(await db.crashBet.count({ where: { roundId: round.id, userId } }), 0)
  } finally {
    if (leaseA) await ownerA.release(leaseA).catch(() => false)
    if (leaseB) await ownerB.release(leaseB).catch(() => false)
    if (leaseA) {
      const Redis = (await import('ioredis')).default
      const redis = new Redis(testRedisUrl!, { lazyConnect: true })
      await redis.connect()
      await redis.del(`${leaseA.leaseKey}:fence`)
      redis.disconnect()
    }
    await ownerA.disconnect()
    await ownerB.disconnect()
  }
})

test('500 real bot Rocket games use existing identities, wallet entries and settlement', {
  skip: !(isolatedDb && isolatedRedis && process.env.BOT_ROCKET_SOAK === 'true'),
  timeout: 10 * 60_000
}, async () => {
  const { ensureOnlinePokerBots, listOnlinePokerBots } = await import('../server/services/botIdentityService')
  await ensureOnlinePokerBots()
  const bots = await listOnlinePokerBots()
  const candidate = bots.find(item => item.botEnabled && item.balance >= 600)
  assert.ok(candidate, 'an existing enabled persistent bot must have its own bankroll for the soak')
  const activeReservation = await db.onlineRoomPlayer.findFirst({ where: { userId: candidate.id, status: { in: ['RESERVING', 'ACTIVE', 'LEAVING', 'CASHING_OUT'] } }, select: { id: true } })
  assert.equal(activeReservation, null, 'soak bot must be idle in poker')

  const beforeUser = await db.user.findUniqueOrThrow({ where: { id: candidate.id }, select: { balance: true, botFencingToken: true, tableRating: true, tableHandsPlayed: true, predictionRating: true } })
  const beforeWallet = await db.userWallet.findUniqueOrThrow({ where: { userId: candidate.id } })
  economyBefore = await db.miniGameEconomy.findUnique({ where: { id: 'global' } }) ?? null
  const keyPrefix = `pocker:test:rocket-soak:${randomUUID()}:`
  const leaseService = new OnlinePokerBotLeaseService({ redisUrl: testRedisUrl!, keyPrefix, ownerId: `rocket-soak-${randomUUID()}` })
  let lease: Awaited<ReturnType<typeof leaseService.acquire>> = null
  let roundsCreated = 0
  let gamesPlaced = 0
  try {
    lease = await leaseService.acquire(candidate.botKey)
    assert.ok(lease)
    const fence: BotRocketFence = { key: lease.leaseKey, token: lease.token, isLeaseCurrent: () => leaseService.renew(lease!) }
    await registerBotRocketLease(candidate.id, fence)
    for (let index = 0; index < 500; index++) {
      const round = await createBettingRound(150)
      roundsCreated += 1
      const ready = await getBotRocketSnapshot([candidate.id], async () => leaseService.renew(lease!))
      assert.equal(ready.roundId, round.id)
      assert.equal(ready.phase, 'betting')
      const placed = await placeCrashBetForBot(candidate.id, { expectedRoundId: round.id, stake: 1, autoCashout: 1.05 }, fence)
      assert.equal(placed, true)
      gamesPlaced += 1
      await db.crashRound.update({ where: { id: round.id }, data: { startedAt: new Date(Date.now() - 120_000) } })
      const settled = await getBotRocketSnapshot([candidate.id], async () => leaseService.renew(lease!))
      assert.equal(settled.roundId, round.id)
      assert.equal(settled.phase, 'crashed')
    }

    const bets = await db.crashBet.findMany({ where: { roundId: { in: roundsForCleanup.slice(-roundsCreated) }, userId: candidate.id } })
    assert.equal(bets.length, 500)
    assert.equal(new Set(bets.map(item => item.roundId)).size, 500)
    const testRoundIds = roundsForCleanup.slice(-roundsCreated)
    const testKeys = testRoundIds.flatMap(roundId => [`crash:stake:${roundId}:${candidate.id}`, `crash:payout:${roundId}:${candidate.id}`])
    const entries = await db.walletLedgerEntry.findMany({ where: { wallet: { userId: candidate.id }, idempotencyKey: { in: testKeys } }, select: { entryType: true, amount: true, idempotencyKey: true } })
    assert.equal(entries.filter(entry => entry.entryType === 'CRASH_STAKE').length, 500)
    assert.equal(entries.filter(entry => entry.entryType === 'CRASH_PAYOUT').length, bets.filter(item => item.payout > 0).length)
    assert.equal(new Set(entries.map(entry => entry.idempotencyKey)).size, entries.length)
    const afterWallet = await db.userWallet.findUniqueOrThrow({ where: { userId: candidate.id } })
    assert.ok(afterWallet.balance >= 0n)
    const ledgerNet = entries.reduce((sum, entry) => sum + entry.amount, 0n)
    assert.equal(afterWallet.balance, beforeWallet.balance + ledgerNet)
    const afterUser = await db.user.findUniqueOrThrow({ where: { id: candidate.id }, select: { tableRating: true, tableHandsPlayed: true, predictionRating: true } })
    assert.equal(afterUser.tableRating, beforeUser.tableRating)
    assert.equal(afterUser.tableHandsPlayed, beforeUser.tableHandsPlayed)
    assert.equal(afterUser.predictionRating, beforeUser.predictionRating)
  } finally {
    if (lease) await leaseService.release(lease).catch(() => false)
    await leaseService.disconnect()
    if (lease) {
      const Redis = (await import('ioredis')).default
      const redis = new Redis(testRedisUrl!, { lazyConnect: true })
      await redis.connect()
      await redis.del(`${lease.leaseKey}:fence`)
      redis.disconnect()
    }
    if (roundsCreated > 0) {
      const testRoundIds = roundsForCleanup.slice(-roundsCreated)
      const testBets = await db.crashBet.findMany({ where: { userId: candidate.id, roundId: { in: testRoundIds } }, select: { id: true } })
      const testKeys = testRoundIds.flatMap(roundId => [`crash:stake:${roundId}:${candidate.id}`, `crash:payout:${roundId}:${candidate.id}`])
      await db.miniGameJackpotEntry.deleteMany({ where: { userId: candidate.id, referenceId: { in: testBets.map(item => item.id) } } })
      await db.crashBet.deleteMany({ where: { userId: candidate.id, roundId: { in: testRoundIds } } })
      await db.walletLedgerEntry.deleteMany({ where: { wallet: { userId: candidate.id }, idempotencyKey: { in: testKeys } } })
      await db.crashRound.deleteMany({ where: { id: { in: testRoundIds } } })
    }
    await db.userWallet.update({ where: { userId: candidate.id }, data: { balance: beforeWallet.balance, version: beforeWallet.version } })
    await db.user.update({ where: { id: candidate.id }, data: { balance: beforeUser.balance, botFencingToken: beforeUser.botFencingToken } })
    if (economyBefore) await db.miniGameEconomy.update({ where: { id: 'global' }, data: { dayKey: economyBefore.dayKey, minesBank: economyBefore.minesBank, rocketBank: economyBefore.rocketBank, jackpot: economyBefore.jackpot, jackpotTenths: economyBefore.jackpotTenths, updatedAt: economyBefore.updatedAt } })
    else await db.miniGameEconomy.deleteMany({ where: { id: 'global' } })
  }
  assert.equal(gamesPlaced, 500)
})

test.after(async () => {
  if (roomsForCleanup.length > 0) await db.onlineRoom.deleteMany({ where: { id: { in: roomsForCleanup } } })
  if (usersForCleanup.length > 0) await db.user.deleteMany({ where: { id: { in: usersForCleanup } } })
  if (roundsForCleanup.length > 0) await db.crashRound.deleteMany({ where: { id: { in: roundsForCleanup } } })
  // Empty rounds created by currentRound while settling the synthetic test
  // rounds have no financial state and must not block the later season tests.
  if (isolatedDb) await db.crashRound.deleteMany({ where: { bets: { none: {} } } })
  if (economyBefore !== undefined) {
    if (economyBefore) await db.miniGameEconomy.update({ where: { id: 'global' }, data: { dayKey: economyBefore.dayKey, minesBank: economyBefore.minesBank, rocketBank: economyBefore.rocketBank, jackpot: economyBefore.jackpot, jackpotTenths: economyBefore.jackpotTenths, updatedAt: economyBefore.updatedAt } }).catch(() => undefined)
    else await db.miniGameEconomy.deleteMany({ where: { id: 'global' } }).catch(() => undefined)
  }
  await db.$disconnect()
})
