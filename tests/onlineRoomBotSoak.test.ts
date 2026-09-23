import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import Redis from 'ioredis'
import { ensureOnlinePokerBots, listOnlinePokerBots, type PersistentBotIdentity } from '../server/services/botIdentityService'
import { onlinePokerBotApiAdapter, withOnlinePokerBotApiDependencies } from '../server/services/onlinePokerBotApiAdapter'
import { OnlinePokerBotLeaseService } from '../server/services/onlinePokerBotLeaseService'
import { OnlinePokerBotOrchestrator, type OnlinePokerBotOrchestratorAdapter } from '../server/services/onlinePokerBotOrchestrator'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { decideBotAction, createSeededBotRandom } from '../server/utils/pokerBotDecision'
import { registerUser } from '../server/services/userAccountService'
import { applyAuthenticatedOnlineRoomAction, getAuthenticatedOnlineRoom, getOnlinePokerBotDecisionSnapshot, joinAuthenticatedOnlineRoom, setAuthenticatedOnlineRoomReady, startAuthenticatedOnlineRoomHand, leaveAuthenticatedOnlineRoom, createAuthenticatedOnlineRoom } from '../server/services/onlineRoomApiService'
import type { OnlineRoomTurnTimerService } from '../server/services/onlineRoomTurnTimerService'

const dbUrl = process.env.DATABASE_URL
const testRedisUrl = process.env.ONLINE_POKER_BOT_TEST_REDIS_URL ?? process.env.ONLINE_ROOM_TEST_REDIS_URL
const redisUrl = testRedisUrl?.replace(/\/(\d+)$/, (_match, index: string) => `/${Number(index) + 1}`)
const isolated = Boolean(dbUrl && redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const db = new PrismaClient()
const runtimePrefix = `test:online-poker-bot-soak:${randomUUID()}:`
const leasePrefix = `${runtimePrefix}lease:`
const runtime = new OnlineRoomRuntimeStore({ redisUrl: redisUrl ?? 'redis://127.0.0.1:6379/3', keyPrefix: runtimePrefix })
const timer = {
  start: () => undefined,
  schedule: async () => undefined,
  clear: async () => undefined
} as unknown as OnlineRoomTurnTimerService
const infrastructure = { runtime, timer }
const fenced = (dependencies: Parameters<typeof withOnlinePokerBotApiDependencies>[0]) => withOnlinePokerBotApiDependencies(dependencies, infrastructure)
let botIdentities: readonly PersistentBotIdentity[] = []
let roomIds: string[] = []
let humanId: string | null = null
const accountSnapshots = new Map<string, { user: Record<string, any>; walletBalance: bigint; walletId: string }>()
const baselineWalletEntryIds = new Set<string>()
const baselineOnlineRatingIds = new Set<string>()
const baselineTableRatingIds = new Set<string>()
let soakStartedAt = new Date()
const operationFailures: string[] = []

async function fundSoakWallet(userId: string, amount: bigint, grantKey: string): Promise<void> {
  const wallet = await db.userWallet.findUniqueOrThrow({ where: { userId }, select: { id: true, balance: true } })
  if (wallet.balance >= amount) return
  await db.$transaction(async tx => {
    const delta = amount - wallet.balance
    await tx.userWallet.update({ where: { id: wallet.id }, data: { balance: amount, version: { increment: 1 } } })
    await tx.user.update({ where: { id: userId }, data: { balance: Number(amount) } })
    await tx.walletLedgerEntry.create({ data: {
      walletId: wallet.id,
      transferId: randomUUID(),
      entryType: 'TEST_BOT_SOAK_FUNDING',
      amount: delta,
      balanceAfter: amount,
      idempotencyKey: grantKey,
      metadata: { testOnly: true, reason: 'stable multi-hand soak bankroll' }
    } })
  })
}

before(async () => {
  if (!isolated) return
  botIdentities = await ensureOnlinePokerBots()
  const chosen = botIdentities
  for (const bot of chosen) {
    const row = await db.user.findUniqueOrThrow({ where: { id: bot.id }, include: { wallet: true } })
    assert.ok(row.wallet)
    accountSnapshots.set(bot.id, { user: row as unknown as Record<string, any>, walletBalance: row.wallet.balance, walletId: row.wallet.id })
  }
  const walletIds = [...accountSnapshots.values()].map(item => item.walletId)
  for (const row of await db.walletLedgerEntry.findMany({ where: { walletId: { in: walletIds } }, select: { id: true } })) baselineWalletEntryIds.add(row.id)
  // Explicit, test-only bankroll so stochastic hands do not turn a requested
  // three-hand lifecycle check into a legitimate production bankruptcy case.
  for (const bot of chosen) await fundSoakWallet(bot.id, 1_000_000_000n, `test-bot-soak-funding:${randomUUID()}:${bot.id}`)
  for (const row of await db.onlinePokerRatingEvent.findMany({ where: { userId: { in: chosen.map(bot => bot.id) } }, select: { id: true } })) baselineOnlineRatingIds.add(row.id)
  for (const row of await db.tableRatingEvent.findMany({ where: { userId: { in: chosen.map(bot => bot.id) } }, select: { id: true } })) baselineTableRatingIds.add(row.id)
  soakStartedAt = new Date()
})

after(async () => {
  if (isolated) {
    for (const roomId of roomIds) {
      const record = await runtime.get(roomId).catch(() => null)
      if (record) await runtime.remove(roomId, record.runtimeRevision).catch(() => undefined)
    }
    const createdRoomIds = [...new Set(roomIds)]
    if (createdRoomIds.length) {
      await db.roomCodeRegistry.deleteMany({ where: { roomType: 'ONLINE', targetId: { in: createdRoomIds } } })
      await db.onlineRoom.deleteMany({ where: { id: { in: createdRoomIds } } })
    }
    const chosenIds = [...accountSnapshots.keys()]
    const walletIds = [...accountSnapshots.values()].map(item => item.walletId)
    const newWalletRows = await db.walletLedgerEntry.findMany({ where: { walletId: { in: walletIds } }, select: { id: true } })
    await db.walletLedgerEntry.deleteMany({ where: { id: { in: newWalletRows.map(row => row.id).filter(id => !baselineWalletEntryIds.has(id)) } } })
    const newOnlineRows = await db.onlinePokerRatingEvent.findMany({ where: { userId: { in: chosenIds } }, select: { id: true } })
    await db.onlinePokerRatingEvent.deleteMany({ where: { id: { in: newOnlineRows.map(row => row.id).filter(id => !baselineOnlineRatingIds.has(id)) } } })
    const newTableRows = await db.tableRatingEvent.findMany({ where: { userId: { in: chosenIds } }, select: { id: true } })
    await db.tableRatingEvent.deleteMany({ where: { id: { in: newTableRows.map(row => row.id).filter(id => !baselineTableRatingIds.has(id)) } } })
    for (const [userId, snapshot] of accountSnapshots) {
      await db.$transaction(async tx => {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, wallet: _wallet, ...data } = snapshot.user
        await tx.user.update({ where: { id: userId }, data })
        await tx.userWallet.update({ where: { userId }, data: { balance: snapshot.walletBalance } })
      })
    }
    if (humanId) await db.user.delete({ where: { id: humanId } }).catch(() => undefined)
    const redis = new Redis(redisUrl!, { lazyConnect: true })
    await redis.connect()
    for (const prefix of [runtimePrefix, leasePrefix]) {
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
        cursor = next
        if (keys.length) await redis.del(...keys)
      } while (cursor !== '0')
    }
    redis.disconnect()
  }
  await runtime.disconnect()
  await db.$disconnect()
})

function apiWithInfrastructure(bots?: readonly PersistentBotIdentity[], targetRoomCode?: () => string | null): OnlinePokerBotOrchestratorAdapter {
  const base = onlinePokerBotApiAdapter
  const recordFailure = (operation: string, error: unknown) => operationFailures.push(`${operation}:${(error as { code?: unknown } | null)?.code ?? 'OPERATION_FAILED'}:${error instanceof Error ? error.message : 'unknown error'}`)
  return {
    ...base,
    cleanupBotCreatedRooms: (botIds, before) => base.cleanupBotCreatedRooms(botIds, before, infrastructure),
    ...(bots ? { listBots: async () => bots } : {}),
    ...(targetRoomCode ? { listPublicRooms: async () => {
      const code = targetRoomCode()
      return code ? (await base.listPublicRooms()).filter(room => room.code === code) : []
    } } : {}),
    getRoom: async (userId, code, dependencies) => {
      try { return await base.getRoom(userId, code, fenced(dependencies)) }
      catch (error) {
        const metadata = await db.onlineRoom.findUnique({ where: { roomCode: code }, select: { id: true, status: true, ownerId: true } }).catch(() => null)
        const reservation = metadata ? await db.onlineRoomPlayer.findFirst({ where: { roomId: metadata.id, userId }, select: { status: true } }).catch(() => null) : null
        const runtimeState = metadata ? await runtime.get(metadata.id).catch(() => null) : null
        recordFailure('getRoom', Object.assign(new Error(`${error instanceof Error ? error.message : 'unknown error'}; metadata=${metadata?.status ?? 'missing'}; owner=${metadata?.ownerId ?? 'missing'}; reservation=${reservation?.status ?? 'missing'}; runtime=${runtimeState ? 'present' : 'missing'}`), { code: (error as { code?: unknown } | null)?.code }))
        throw error
      }
    },
    getDecisionSnapshot: async (userId, code, dependencies) => { try { return await base.getDecisionSnapshot(userId, code, fenced(dependencies)) } catch (error) { recordFailure('decision', error); throw error } },
    createRoom: (userId, input, dependencies) => base.createRoom(userId, input, fenced(dependencies)),
    joinRoom: async (userId, code, dependencies) => { try { return await base.joinRoom(userId, code, fenced(dependencies)) } catch (error) { recordFailure('join', error); throw error } },
    ready: async (userId, code, ready, room, dependencies) => { try { return await base.ready(userId, code, ready, room, fenced(dependencies)) } catch (error) { recordFailure('ready', error); throw error } },
    startHand: async (userId, code, version, dependencies) => { try { return await base.startHand(userId, code, version, fenced(dependencies)) } catch (error) { recordFailure('start', error); throw error } },
    action: async (userId, code, input, dependencies) => { try { return await base.action(userId, code, input, fenced(dependencies)) } catch (error) { recordFailure('action', error); throw error } },
    leave: async (userId, code, room, dependencies) => { try { return await base.leave(userId, code, room, fenced(dependencies)) } catch (error) { recordFailure('leave', error); throw error } }
  }
}

function makeOrchestrator(bots: readonly PersistentBotIdentity[], adapter: OnlinePokerBotOrchestratorAdapter, leases: OnlinePokerBotLeaseService, clock: { value: number }, log: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void) {
  return new OnlinePokerBotOrchestrator({
    config: {
      enabled: true, minActiveBots: bots.length, maxActiveBots: bots.length, maxBotsPerRoom: 3, maxBotCreatedRooms: 0,
      tickIntervalMs: 1_000, activityWindowMs: 24 * 60 * 60_000, startingStack: 1_000, smallBlind: 1, bigBlind: 2,
      quickJoinProbability: 1, createRoomProbability: 0
    },
    lease: leases,
    adapter,
    now: () => clock.value,
    random: createSeededBotRandom(Number(process.env.ONLINE_BOT_SOAK_SEED ?? 142_857)),
    log
  })
}

function roomDeps(dependencies: Parameters<typeof withOnlinePokerBotApiDependencies>[0]) { return fenced(dependencies) }

async function prepareBotRoom(bots: readonly PersistentBotIdentity[], adapter = apiWithInfrastructure(), startingStack = 1_000, smallBlind = 1, bigBlind = 2) {
  const startingBalances = await Promise.all(bots.map(bot => db.userWallet.findUniqueOrThrow({ where: { userId: bot.id }, select: { balance: true } })))
  const createDeps = { botFence: undefined }
  const created = await createAuthenticatedOnlineRoom(bots[0]!.id, { visibility: 'PUBLIC', startingStack, smallBlind, bigBlind }, roomDeps(createDeps))
  roomIds.push(created.room.roomId)
  for (const bot of bots.slice(1)) await joinAuthenticatedOnlineRoom(bot.id, created.room.roomCode, {}, roomDeps(createDeps))
  const entries = await db.walletLedgerEntry.findMany({ where: { idempotencyKey: { startsWith: `online-buyin:${created.room.roomId}:` } }, select: { idempotencyKey: true } })
  assert.equal(entries.length, bots.length)
  return { room: created.room, initialWallets: new Map(bots.map((bot, index) => [bot.id, startingBalances[index]!.balance])) }
}

async function playHandsThroughOrchestrator(bots: readonly PersistentBotIdentity[], targetHands: number, includeSecondWorker = false, startingStack = 5_000, smallBlind = 1, bigBlind = 2): Promise<void> {
  let targetRoomCode: string | null = null
  const adapter = apiWithInfrastructure(bots, () => targetRoomCode)
  const runStartedAt = new Date()
  const { room, initialWallets } = await prepareBotRoom(bots, adapter, startingStack, smallBlind, bigBlind)
  targetRoomCode = room.roomCode
  const clock = { value: Date.now() + 20_000 }
  const logEvents: string[] = []
  const actionIds = new Set<string>()
  const rejects: string[] = []
  const logged = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => {
    logEvents.push(event)
    if (event === 'bot_orchestrator_operation_rejected') rejects.push(String(fields.code))
  }
  const realAdapter = adapter
  const instrumented: OnlinePokerBotOrchestratorAdapter = {
    ...realAdapter,
    getDecisionSnapshot: async (userId, code, dependencies) => {
      const snapshot = await realAdapter.getDecisionSnapshot(userId, code, dependencies)
      const opponents = snapshot.room.pokerTable.currentHand?.players.filter(player => player.playerId !== userId) ?? []
      assert.ok(opponents.every(player => player.holeCards.length === 0), 'strategy input must not contain opponent hole cards')
      assert.equal('deck' in (snapshot.room.pokerTable.currentHand ?? {}), false)
      return snapshot
    },
    action: async (userId, code, input, dependencies) => {
      assert.equal(actionIds.has(input.actionId), false, 'a bot action id must not be reused')
      actionIds.add(input.actionId)
      return realAdapter.action(userId, code, input, dependencies)
    }
  }
  const runLeasePrefix = `${leasePrefix}${randomUUID()}:`
  const firstLease = new OnlinePokerBotLeaseService({ redisUrl, keyPrefix: runLeasePrefix, ownerId: randomUUID() })
  const secondLease = includeSecondWorker ? new OnlinePokerBotLeaseService({ redisUrl, keyPrefix: runLeasePrefix, ownerId: randomUUID() }) : null
  let first = makeOrchestrator(bots, instrumented, firstLease, clock, logged)
  const second = secondLease ? makeOrchestrator(bots, instrumented, secondLease, clock, logged) : null
  let distinctHands = 0
  let iterations = 0
  while (distinctHands < targetHands && iterations < targetHands * 250) {
    if (second && iterations < 8) {
      await first.tick()
      await second.tick()
    }
    else if (second && iterations === 8) {
      // Simulate a process crash: drop Redis without releasing any lease, then
      // let its real TTL expire before the second app instance takes over.
      firstLease.disconnect()
      await new Promise(resolve => setTimeout(resolve, 8_200))
      await second.tick()
      first = second
    } else await (second ? second.tick() : first.tick())
    clock.value += 10_000
    const current = await getAuthenticatedOnlineRoom(bots[0]!.id, room.roomCode, infrastructure)
    const table = current.room.pokerTable
    assert.equal(new Set(table.players.map(player => player.playerId)).size, table.players.length, 'duplicate seat detected')
    const ids = bots.map(bot => bot.id)
    const accounts = await db.userWallet.findMany({ where: { userId: { in: ids } }, select: { id: true, userId: true, balance: true } })
    const accountTotal = accounts.reduce((total, row) => total + row.balance, 0n)
    const achievementRewards = await db.walletLedgerEntry.aggregate({
      where: { walletId: { in: accounts.map(account => account.id) }, entryType: 'ACHIEVEMENT_REWARD', createdAt: { gte: runStartedAt } },
      _sum: { amount: true }
    })
    const allowedSystemRewards = achievementRewards._sum.amount ?? 0n
    const inHand = new Set(table.currentHand?.players.map(player => player.playerId) ?? [])
    const tableOnlyStacks = table.players.filter(player => !inHand.has(player.playerId)).reduce((total, player) => total + BigInt(player.stack), 0n)
    const tableTotal = tableOnlyStacks + (table.currentHand
      ? table.currentHand.players.reduce((total, player) => total + BigInt(player.stack), 0n) + BigInt(table.currentHand.pot)
      : 0n)
    const expectedTotal = [...initialWallets.values()].reduce((total, balance) => total + balance, 0n) + allowedSystemRewards
    assert.equal(accountTotal + tableTotal, expectedTotal, `account + table + committed pot chips must be conserved outside explicitly recorded existing system rewards (accounts=${accountTotal}; stacks=${table.players.map(player => player.stack).join(',')}; pot=${table.currentHand?.pot ?? 0}; handStacks=${table.currentHand?.players.map(player => player.stack).join(',') ?? 'none'}; allowedAchievementRewards=${allowedSystemRewards}; expected=${expectedTotal})`)
    const rows = await db.onlinePokerRatingEvent.findMany({ where: { userId: { in: ids }, createdAt: { gte: runStartedAt } }, select: { handId: true }, distinct: ['handId'] })
    distinctHands = rows.length
    if (table.players.some(player => player.stack <= 0) && table.currentHand?.street === 'FINISHED' && table.players.filter(player => player.stack > 0).length < 2 && distinctHands < targetHands) break
    clock.value += 0
    iterations += 1
  }
  assert.ok(distinctHands >= targetHands, `completed ${distinctHands} of ${targetHands} requested hands in ${iterations} ticks`)
  assert.ok(actionIds.size > targetHands, 'bots should have taken real server-authoritative actions')
  assert.equal(rejects.filter(code => ['INVALID_ACTION', 'NOT_YOUR_TURN', 'STALE_STATE'].includes(code)).length, 0, `unexpected illegal/stale bot actions: ${rejects.join(', ')}`)
  assert.ok(logEvents.includes('bot_joined_public_room') || bots.length > 1)

  firstLease.disconnect()
  await secondLease?.disconnect()
  const final = await getAuthenticatedOnlineRoom(bots[0]!.id, room.roomCode, infrastructure)
  if (final.room.pokerTable.currentHand?.street === 'FINISHED' || !final.room.pokerTable.currentHand) {
    for (const bot of bots) {
      const state = await getAuthenticatedOnlineRoom(bot.id, room.roomCode, infrastructure)
      if (state.room.pokerTable.players.some(player => player.playerId === bot.id)) {
        await leaveAuthenticatedOnlineRoom(bot.id, room.roomCode, { concurrencyToken: state.concurrencyToken, expectedRoomVersion: state.room.roomVersion }, infrastructure)
      }
    }
    const playerRows = await db.onlineRoomPlayer.findMany({ where: { roomId: room.roomId, userId: { in: bots.map(bot => bot.id) } }, select: { userId: true, status: true, buyInSequence: true } })
    assert.equal(playerRows.length, bots.length)
    assert.ok(playerRows.every(row => row.status === 'CASHED_OUT'))
    for (const bot of bots) {
      const buyIns = await db.walletLedgerEntry.count({ where: { idempotencyKey: `online-buyin:${room.roomId}:${bot.id}:0` } })
      assert.equal(buyIns, 1, 'each bot should have exactly one ordinary buy-in debit')
      const cashOuts = await db.walletLedgerEntry.count({ where: { idempotencyKey: `online-cashout:${room.roomId}:${bot.id}:0` } })
      assert.ok(cashOuts <= 1, 'cash-out must not be credited twice')
    }
  }
}

test('two persistent bots complete a 100-hand public-room soak across a lease-owner crash', { skip: !isolated, timeout: 10 * 60_000 }, async () => {
  const bots = await listOnlinePokerBots()
  await playHandsThroughOrchestrator([bots[0]!, bots[1]!], 100, true, 5_000, 1, 1)
})

test('three persistent bots complete a 100-hand public self-play soak', { skip: !isolated, timeout: 10 * 60_000 }, async () => {
  const bots = await listOnlinePokerBots()
  await playHandsThroughOrchestrator([bots[5]!, bots[8]!, bots[9]!], 100, false, 5_000, 1, 1)
})

test('a registered human and bots complete public-room hands through the same engine', { skip: !isolated, timeout: 2 * 60_000 }, async () => {
  operationFailures.length = 0
  const bots = await listOnlinePokerBots()
  const createdHuman = await registerUser({ username: `soakhuman${randomUUID().slice(0, 8)}`, password: 'test-only-123' })
  humanId = (createdHuman.user as { id: string }).id
  await fundSoakWallet(humanId, 1_000_000_000n, `test-bot-soak-human-funding:${randomUUID()}:${humanId}`)
  let targetRoomCode: string | null = null
  const humanRoomBots = bots.slice(6, 8)
  const adapter = apiWithInfrastructure(humanRoomBots, () => targetRoomCode)
  const participants = [humanId, ...humanRoomBots.map(bot => bot.id)]
  const initialBalances = await db.userWallet.findMany({ where: { userId: { in: participants } }, select: { userId: true, balance: true } })
  const initialTotal = initialBalances.reduce((total, wallet) => total + wallet.balance, 0n)
  const runStartedAt = new Date()
  const createdRoom = await createAuthenticatedOnlineRoom(humanId, { visibility: 'PUBLIC', startingStack: 100_000_000, smallBlind: 1, bigBlind: 2 }, infrastructure)
  roomIds.push(createdRoom.room.roomId)
  const roomCode = createdRoom.room.roomCode
  targetRoomCode = roomCode
  for (const bot of humanRoomBots) await joinAuthenticatedOnlineRoom(bot.id, roomCode, {}, infrastructure)
  const buyIns = await db.walletLedgerEntry.count({ where: { idempotencyKey: { startsWith: `online-buyin:${createdRoom.room.roomId}:` } } })
  assert.equal(buyIns, 1 + humanRoomBots.length)
  let safe = await getAuthenticatedOnlineRoom(humanId, roomCode, infrastructure)
  await setAuthenticatedOnlineRoomReady(humanId, roomCode, { ready: true, concurrencyToken: safe.concurrencyToken }, infrastructure)
  const clock = { value: Date.now() + 20_000 }
  const lease = new OnlinePokerBotLeaseService({ redisUrl, keyPrefix: `${leasePrefix}${randomUUID()}:`, ownerId: randomUUID() })
  const events: string[] = []
  const orchestrator = makeOrchestrator(humanRoomBots, adapter, lease, clock, (event, fields) => events.push(`${event}:${String(fields.operation ?? '')}:${String(fields.code ?? '')}`))
  let completed = 0
  let previousHands = 0
  let terminalStackExhaustion = false
  for (let i = 0; i < 2_000 && completed < 3; i += 1) {
    await orchestrator.tick()
    const rejected = events.filter(event => event.startsWith('bot_orchestrator_operation_rejected:'))
    assert.deepEqual(rejected, [], `unexpected orchestrator operation errors: ${rejected.join(',')}; operations=${operationFailures.join(',')}`)
    clock.value += 10_000
    safe = await getAuthenticatedOnlineRoom(humanId, roomCode, infrastructure)
    if (safe.room.ownerId === humanId && (!safe.room.pokerTable.currentHand || safe.room.pokerTable.currentHand.street === 'FINISHED')) {
      const humanSeat = safe.room.pokerTable.players.find(player => player.playerId === humanId)
      if (humanSeat && !humanSeat.ready && humanSeat.stack > 0) {
        await setAuthenticatedOnlineRoomReady(humanId, roomCode, { ready: true, concurrencyToken: safe.concurrencyToken }, infrastructure)
        safe = await getAuthenticatedOnlineRoom(humanId, roomCode, infrastructure)
      }
      const readySeats = safe.room.pokerTable.players.filter(player => player.ready && !player.sittingOut && player.stack > 0)
      if (readySeats.length >= 2) {
        await startAuthenticatedOnlineRoomHand(humanId, roomCode, safe.room.pokerTable.stateVersion, infrastructure)
        safe = await getAuthenticatedOnlineRoom(humanId, roomCode, infrastructure)
      }
    }
    assert.ok(safe.room.pokerTable.players.some(player => player.playerId === humanId), 'human seat must not be displaced by bot activity')
    const hand = safe.room.pokerTable.currentHand
    if (hand?.currentActor !== null && hand?.currentActor !== undefined) {
      const actor = hand.players.find(player => player.seat === hand.currentActor)
      if (actor?.playerId === humanId) {
        const snapshot = await getOnlinePokerBotDecisionSnapshot(humanId, roomCode, infrastructure)
        const own = snapshot.room.pokerTable.currentHand!.players.find(player => player.playerId === humanId)!
        const decision = decideBotAction({
          playerId: humanId,
          street: hand.street as 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER',
          holeCards: own.holeCards,
          board: hand.board,
          pot: hand.pot,
          currentBet: hand.currentBet,
          streetContribution: own.streetContribution,
          toCall: snapshot.toCall,
          stack: own.stack,
          seat: own.seat,
          dealerSeat: hand.dealerSeat,
          smallBlindSeat: hand.smallBlindSeat,
          bigBlindSeat: hand.bigBlindSeat,
          smallBlind: hand.smallBlind,
          bigBlind: hand.bigBlind,
          legalActions: snapshot.legalActions,
          minRaiseTo: snapshot.minRaiseTo,
          raiseReopened: snapshot.raiseReopened
        }, { skillTier: 'CASUAL', playStyle: 'BALANCED' }, createSeededBotRandom(Number(process.env.ONLINE_BOT_SOAK_SEED ?? 142_857) + i + 17))
        await applyAuthenticatedOnlineRoomAction(humanId, roomCode, { actionId: randomUUID(), expectedTableStateVersion: safe.room.pokerTable.stateVersion, action: { type: decision.type, ...(decision.amount === undefined ? {} : { amount: decision.amount }) } }, infrastructure)
      }
    }
    const rows = await db.onlinePokerRatingEvent.findMany({ where: { userId: { in: humanRoomBots.map(bot => bot.id) }, createdAt: { gte: runStartedAt } }, select: { handId: true }, distinct: ['handId'] })
    completed = rows.length
    if (completed > previousHands) previousHands = completed
    const walletRows = await db.userWallet.findMany({ where: { userId: { in: participants } }, select: { userId: true, balance: true } })
    const accountTotal = walletRows.reduce((total, wallet) => total + wallet.balance, 0n)
    const wallets = await db.userWallet.findMany({ where: { userId: { in: participants } }, select: { id: true } })
    const achievementRewards = await db.walletLedgerEntry.aggregate({
      where: { walletId: { in: wallets.map(wallet => wallet.id) }, entryType: 'ACHIEVEMENT_REWARD', createdAt: { gte: runStartedAt } },
      _sum: { amount: true }
    })
    const allowedSystemRewards = achievementRewards._sum.amount ?? 0n
    const inHand = new Set(safe.room.pokerTable.currentHand?.players.map(player => player.playerId) ?? [])
    const tableTotal = safe.room.pokerTable.players.filter(player => !inHand.has(player.playerId)).reduce((total, player) => total + BigInt(player.stack), 0n)
      + (safe.room.pokerTable.currentHand
        ? safe.room.pokerTable.currentHand.players.reduce((total, player) => total + BigInt(player.stack), 0n) + BigInt(safe.room.pokerTable.currentHand.pot)
        : 0n)
    if (accountTotal + tableTotal !== initialTotal + allowedSystemRewards) {
      const walletIds = await db.userWallet.findMany({ where: { userId: { in: participants } }, select: { id: true } })
      const ledger = await db.walletLedgerEntry.findMany({ where: { walletId: { in: walletIds.map(wallet => wallet.id) } }, orderBy: { createdAt: 'desc' }, take: 20, select: { entryType: true, amount: true, idempotencyKey: true } })
      assert.fail(`human+bot account/table/pot chips must be conserved outside explicitly recorded existing system rewards (initial=${initialBalances.map(wallet => `${wallet.userId}:${wallet.balance}`).join('|')}; accounts=${walletRows.map(wallet => `${wallet.userId}:${wallet.balance}`).join('|')}; table=${tableTotal}; expected=${initialTotal + allowedSystemRewards}; allowedAchievementRewards=${allowedSystemRewards}; ledger=${ledger.map(entry => `${entry.entryType}:${entry.amount}:${entry.idempotencyKey}`).join('|')}; seats=${safe.room.pokerTable.players.map(player => `${player.playerId}:${player.stack}`).join('|')}; handStacks=${safe.room.pokerTable.currentHand?.players.map(player => `${player.playerId}:${player.stack}`).join('|') ?? 'none'}; pot=${safe.room.pokerTable.currentHand?.pot ?? 0})`)
    }
    const finished = !safe.room.pokerTable.currentHand || safe.room.pokerTable.currentHand.street === 'FINISHED'
    const fundedSeats = safe.room.pokerTable.players.filter(player => player.stack > 0)
    if (finished && fundedSeats.length < 2 && completed < 3) {
      terminalStackExhaustion = true
      break
    }
  }
  assert.ok(completed >= 3 || terminalStackExhaustion, `human + bot hands completed: ${completed}; seed=${process.env.ONLINE_BOT_SOAK_SEED ?? 142_857}; room=${safe.room.status}; players=${safe.room.pokerTable.players.map(player => `${player.playerId}:${player.ready}:${player.stack}`).join('|')}; hand=${safe.room.pokerTable.currentHand?.street ?? 'none'}:${safe.room.pokerTable.currentHand?.currentActor ?? 'none'}; events=${events.join(',')}; operationFailures=${operationFailures.join(',')}`)
  if (terminalStackExhaustion) console.log(`human+bot soak ended legally after ${completed} hands: fewer than two players retained table chips; seed=${process.env.ONLINE_BOT_SOAK_SEED ?? 142_857}`)
  else console.log(`human+bot soak completed ${completed} hands; seed=${process.env.ONLINE_BOT_SOAK_SEED ?? 142_857}`)
  if (operationFailures.length) console.log(`human+bot soak handled operation conflicts; seed=${process.env.ONLINE_BOT_SOAK_SEED ?? 142_857}; operations=${operationFailures.join(',')}`)
  await orchestrator.shutdown()
  await lease.disconnect()
  void events
})
