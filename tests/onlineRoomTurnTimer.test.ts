import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { processAuthenticatedOnlineRoomTimeout } from '../server/services/onlineRoomApiService'
import {
  OnlineRoomTurnTimerService,
  ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS,
  ONLINE_ROOM_TURN_TIMEOUT_MS,
  type OnlineRoomTurnTimerJob
} from '../server/services/onlineRoomTurnTimerService'
import {
  applyOnlineRoomAction,
  createOnlineRoom,
  joinOnlineRoom,
  setOnlineRoomReady,
  setOnlineRoomConnected,
  setOnlineRoomTurnDeadline,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState,
  type OnlineRoomState
} from '../server/utils/pokerOnlineRoom'
import { advanceTableStreet, applyTableAction, type PokerTableState } from '../server/utils/pokerTableState'
import { createStandardDeck } from '../server/utils/pokerDeck'

const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const prefixes: string[] = []

function timer(): OnlineRoomTurnTimerService {
  const prefix = `pocker:test:turn-timer:${randomUUID()}:`
  prefixes.push(prefix)
  return new OnlineRoomTurnTimerService({ redis: redis!, keyPrefix: prefix, pollIntervalMs: 50 })
}

function timerWithPrefix(prefix: string): OnlineRoomTurnTimerService {
  if (!prefixes.includes(prefix)) prefixes.push(prefix)
  return new OnlineRoomTurnTimerService({ redis: redis!, keyPrefix: prefix, pollIntervalMs: 50 })
}

function runtime(): OnlineRoomRuntimeStore {
  const store = new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix: `pocker:test:turn-runtime:${randomUUID()}:`, ttlSeconds: 60 })
  prefixes.push(store.keyFor('cleanup'))
  return store
}

function runningRoom(): OnlineRoomState {
  let room = createOnlineRoom({ roomId: randomUUID(), roomCode: 'AB2345', ownerId: 'owner', ownerStack: 100, ownerSeat: 1, smallBlind: 5, bigBlind: 10 })
  room = joinOnlineRoom(room, { playerId: 'other', seat: 2, stack: 100 })
  room = setOnlineRoomReady(room, 'owner', true)
  room = setOnlineRoomReady(room, 'other', true)
  return startOnlineRoomHand(room, { deck: createStandardDeck() })
}

function runtimeRoom(state = runningRoom()): { state: OnlineRoomState; runtime: OnlineRoomRuntimeStore; timer: OnlineRoomTurnTimerService } {
  return { state, runtime: runtime(), timer: timer() }
}

function currentJob(state: OnlineRoomState, deadlineAt = Date.now() - 1): Omit<OnlineRoomTurnTimerJob, 'jobId'> {
  const hand = state.pokerTable.currentHand!
  const actor = hand.players.find(player => player.seat === hand.currentActor)!
  return {
    roomId: state.roomId,
    roomCode: state.roomCode,
    playerId: actor.playerId,
    expectedTableStateVersion: state.pokerTable.stateVersion,
    handId: hand.handId,
    street: hand.street,
    deadlineAt
  }
}

test.before(async () => {
  if (isolated) await redis!.connect()
})

test.after(async () => {
  if (isolated) {
    for (const prefix of prefixes) {
      const keys = await redis!.keys(`${prefix}*`)
      if (keys.length > 0) await redis!.del(...keys)
    }
    redis!.disconnect()
  }
})

test('shared timer stores a 30 second deadline and safe state exposes only the deadline', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() + ONLINE_ROOM_TURN_TIMEOUT_MS
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  const job = await fixture.timer.schedule(currentJob(state, deadlineAt))
  assert.ok(job)
  const safe = toPlayerSafeOnlineRoomState(state, 'owner')
  assert.equal(safe.pokerTable.currentHand?.turnDeadlineAt, deadlineAt)
  assert.equal('jobId' in (safe as object), false)
  assert.equal(job.deadlineAt, deadlineAt)
  await fixture.timer.disconnect()
})

test('auto-fold uses the existing engine and is applied once', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  const created = await fixture.runtime.create(state)
  await fixture.timer.schedule(currentJob(state, deadlineAt))
  const processed = await fixture.timer.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: fixture.timer }))
  assert.equal(processed, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.ok(updated)
  assert.equal(updated.state.pokerTable.players.find(player => player.playerId === 'owner')?.stack, created.state.pokerTable.players.find(player => player.playerId === 'owner')?.stack)
  assert.equal(updated.state.pokerTable.currentHand?.street, 'FINISHED')
  assert.equal(updated.state.turnDeadlineAt, null)
  assert.equal(await fixture.timer.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: fixture.timer })), 0)
  await fixture.timer.disconnect()
})

test('timeout check advances through the normal betting engine when check is legal', { skip: !isolated }, async () => {
  const started = runningRoom()
  const firstActor = started.pokerTable.currentHand!.players.find(player => player.seat === started.pokerTable.currentHand!.currentActor)!
  const called = applyOnlineRoomAction(started, { action: { playerId: firstActor.playerId, type: 'call' } })
  const secondActor = called.pokerTable.currentHand!.players.find(player => player.seat === called.pokerTable.currentHand!.currentActor)!
  const checked = applyOnlineRoomAction(called, { action: { playerId: secondActor.playerId, type: 'check' } })
  const table = advanceTableStreet(checked.pokerTable)
  const state = setOnlineRoomTurnDeadline(Object.freeze({ ...checked, pokerTable: table }), Date.now() - 1)
  const fixture = { ...runtimeRoom(state), state }
  await fixture.runtime.create(state)
  await fixture.timer.schedule(currentJob(state, state.turnDeadlineAt!))
  assert.equal(await fixture.timer.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: fixture.timer })), 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.street, 'FLOP')
  assert.equal(updated?.state.pokerTable.currentHand?.players.find(player => player.seat === updated.state.pokerTable.currentHand?.currentActor)?.playerId, 'owner')
  assert.ok(updated?.state.turnDeadlineAt && updated.state.turnDeadlineAt > Date.now())
  await fixture.timer.disconnect()
})

test('one claimed job can be processed by only one worker', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  await fixture.runtime.create(state)
  await fixture.timer.schedule(currentJob(state, deadlineAt))
  const calls: OnlineRoomTurnTimerJob[] = []
  const processor = async (job: OnlineRoomTurnTimerJob) => { calls.push(job); return 'COMPLETED' as const }
  const [first, second] = await Promise.all([fixture.timer.processDue(processor), fixture.timer.processDue(processor)])
  assert.equal(first + second, 1)
  assert.equal(calls.length, 1)
  await fixture.timer.disconnect()
})

test('a new action makes the previous timer stale', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const oldDeadline = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, oldDeadline)
  await fixture.runtime.create(state)
  await fixture.timer.schedule(currentJob(state, oldDeadline))
  const hand = state.pokerTable.currentHand!
  const actor = hand.players.find(player => player.seat === hand.currentActor)!
  const changed = applyOnlineRoomAction(state, { action: { playerId: actor.playerId, type: 'fold' } })
  await fixture.runtime.update(state.roomId, 1, current => changed)
  const result = await fixture.timer.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: fixture.timer }))
  assert.equal(result, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.players.find(player => player.playerId === actor.playerId)?.status, 'FOLDED')
  await fixture.timer.disconnect()
})

test('worker survives service restart because jobs remain in Redis', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-restart:${randomUUID()}:`
  const first = new OnlineRoomTurnTimerService({ redis: redis!, keyPrefix: prefix, pollIntervalMs: 50 })
  const second = new OnlineRoomTurnTimerService({ redis: redis!, keyPrefix: prefix, pollIntervalMs: 50 })
  const job = currentJob(runningRoom(), Date.now() + 60_000)
  await first.schedule(job)
  await first.disconnect()
  let seen = 0
  await second.processDue(() => { seen += 1; return Promise.resolve('COMPLETED' as const) }, Date.now() + 60_001)
  assert.equal(seen, 1)
  await second.disconnect()
})

test('Redis failure does not run a local timeout action', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const state = setOnlineRoomTurnDeadline(fixture.state, Date.now() - 1)
  const created = await fixture.runtime.create(state)
  const broken = new OnlineRoomTurnTimerService({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: `pocker:test:broken-timer:${randomUUID()}:` })
  await assert.rejects(broken.processDue(async () => 'COMPLETED'))
  const unchanged = await fixture.runtime.get(state.roomId)
  assert.equal(unchanged?.runtimeRevision, created.runtimeRevision)
  await broken.disconnect()
  await fixture.timer.disconnect()
})

test('disconnect and reconnect preserve the same authoritative deadline', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() + ONLINE_ROOM_TURN_TIMEOUT_MS
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  const disconnected = setOnlineRoomConnected(state, 'owner', false)
  const reconnected = setOnlineRoomConnected(disconnected, 'owner', true)
  assert.equal(disconnected.turnDeadlineAt, deadlineAt)
  assert.equal(reconnected.turnDeadlineAt, deadlineAt)
  assert.equal(reconnected.pokerTable.currentHand?.handId, state.pokerTable.currentHand?.handId)
  await fixture.timer.disconnect()
})

test('all-in runout reaches showdown without creating a timer', { skip: !isolated }, async () => {
  let room = createOnlineRoom({ roomId: randomUUID(), roomCode: 'CD2345', ownerId: 'owner', ownerStack: 5, ownerSeat: 1, smallBlind: 5, bigBlind: 10 })
  room = joinOnlineRoom(room, { playerId: 'other', seat: 2, stack: 5 })
  room = setOnlineRoomReady(room, 'owner', true)
  room = setOnlineRoomReady(room, 'other', true)
  const started = startOnlineRoomHand(room, { deck: createStandardDeck() })
  assert.equal(started.pokerTable.currentHand?.currentActor, null)
  const runout = advanceTableStreet(started.pokerTable)
  assert.equal(runout.currentHand?.street, 'SHOWDOWN')
  const withRoom = Object.freeze({ ...started, pokerTable: runout })
  assert.equal(setOnlineRoomTurnDeadline(withRoom, null).turnDeadlineAt, null)
})

test('reclaimed timer is harmless after an all-in runout', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-all-in:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  await fixture.runtime.create(state)
  await first.schedule(currentJob(state, deadlineAt))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise

  let allInRoom = createOnlineRoom({ roomId: state.roomId, roomCode: state.roomCode, ownerId: 'owner', ownerStack: 5, ownerSeat: 1, smallBlind: 5, bigBlind: 10 })
  allInRoom = joinOnlineRoom(allInRoom, { playerId: 'other', seat: 2, stack: 5 })
  allInRoom = setOnlineRoomReady(allInRoom, 'owner', true)
  allInRoom = setOnlineRoomReady(allInRoom, 'other', true)
  const allInStarted = startOnlineRoomHand(allInRoom, { deck: createStandardDeck() })
  const allIn = Object.freeze({ ...allInStarted, pokerTable: advanceTableStreet(allInStarted.pokerTable), turnDeadlineAt: null })
  await fixture.runtime.update(state.roomId, 1, () => allIn)
  assert.equal(await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await oldWorker, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.street, 'SHOWDOWN')
  assert.equal(updated?.state.turnDeadlineAt, null)
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('a user action wins the race and makes the claimed timeout stale', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  await fixture.runtime.create(state)
  const job = await fixture.timer.schedule(currentJob(state, deadlineAt))
  assert.ok(job)
  const actor = state.pokerTable.currentHand!.players.find(player => player.seat === state.pokerTable.currentHand!.currentActor)!
  const acted = applyOnlineRoomAction(state, { action: { playerId: actor.playerId, type: 'fold' } })
  await fixture.runtime.update(state.roomId, 1, current => setOnlineRoomTurnDeadline(acted, null))
  let result: string | undefined
  await fixture.timer.processDue(claimed => {
    assert.equal(claimed.jobId, job.jobId)
    return processAuthenticatedOnlineRoomTimeout(claimed, { runtime: fixture.runtime, timer: fixture.timer }).then(value => {
      result = value
      return value
    })
  })
  assert.equal(result, 'STALE')
  await fixture.timer.disconnect()
})

test('when timeout wins, a later user mutation loses the runtime CAS race', { skip: !isolated }, async () => {
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  const created = await fixture.runtime.create(state)
  await fixture.timer.schedule(currentJob(state, deadlineAt))
  assert.equal(await fixture.timer.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: fixture.timer })), 1)
  await assert.rejects(fixture.runtime.update(state.roomId, created.runtimeRevision, current => current))
  await fixture.timer.disconnect()
})

test('due job can be claimed with a server fencing token', { skip: !isolated }, async () => {
  const service = timer()
  const job = await service.schedule(currentJob(runningRoom(), Date.now() - 1))
  assert.ok(job)
  let claimed: OnlineRoomTurnTimerJob | undefined
  assert.equal(await service.processDue(next => {
    claimed = next
    return Promise.resolve('STALE' as const)
  }), 1)
  assert.ok(claimed?.claimToken)
  await service.disconnect()
})

test('scheduled payload does not persist the internal fencing token', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-claim-payload:${randomUUID()}:`
  const service = timerWithPrefix(prefix)
  const scheduled = await service.schedule({ ...currentJob(runningRoom(), Date.now() + 10_000), claimToken: 'forbidden-test-token' })
  assert.ok(scheduled)
  const payload = await redis!.get(`${prefix}job:${scheduled.jobId}`)
  assert.ok(payload)
  assert.equal(payload.includes('claimToken'), false)
  assert.equal(payload.includes('forbidden-test-token'), false)
  await service.disconnect()
})

test('worker crash after claim is recovered after the claim lease expires', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-crash:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  await fixture.runtime.create(state)
  await first.schedule(currentJob(state, deadlineAt))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const firstRun = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise

  const reclaimed = await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000)
  assert.equal(reclaimed, 1)
  release()
  assert.equal(await firstRun, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.ok(updated)
  assert.equal(updated.state.pokerTable.currentHand?.players.find(player => player.playerId === 'owner')?.status, 'FOLDED')
  assert.equal(await second.processDue(() => Promise.resolve('COMPLETED' as const)), 0)
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('active claim is invisible to another worker before lease expiry', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-active-lease:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const job = await first.schedule(currentJob(runningRoom(), Date.now() - 1))
  assert.ok(job)
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const firstRun = first.processDue(async () => {
    entered()
    await releasePromise
    return 'COMPLETED' as const
  })
  await enteredPromise
  assert.equal(await second.processDue(() => Promise.resolve('COMPLETED' as const), Date.now()), 0)
  release()
  assert.equal(await firstRun, 1)
  await first.disconnect()
  await second.disconnect()
})

test('reclaimed timeout applies exactly once and the old claim cannot complete it again', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-once:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const state = setOnlineRoomTurnDeadline(fixture.state, Date.now() - 1)
  const created = await fixture.runtime.create(state)
  await first.schedule(currentJob(state, state.turnDeadlineAt!))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise
  assert.equal(await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await oldWorker, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.ok(updated)
  assert.equal(updated.runtimeRevision, created.runtimeRevision + 1)
  assert.equal(await second.processDue(() => Promise.resolve('COMPLETED' as const)), 0)
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('user action wins a reclaimed timer race and the timeout becomes stale', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-action:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const deadlineAt = Date.now() - 1
  const state = setOnlineRoomTurnDeadline(fixture.state, deadlineAt)
  await fixture.runtime.create(state)
  await first.schedule(currentJob(state, deadlineAt))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise
  const actor = state.pokerTable.currentHand!.players.find(player => player.seat === state.pokerTable.currentHand!.currentActor)!
  const acted = applyOnlineRoomAction(state, { action: { playerId: actor.playerId, type: 'fold' } })
  await fixture.runtime.update(state.roomId, 1, () => setOnlineRoomTurnDeadline(acted, null))
  const reclaimed = await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000)
  assert.equal(reclaimed, 1)
  release()
  assert.equal(await oldWorker, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.players.find(player => player.playerId === actor.playerId)?.status, 'FOLDED')
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('street change makes a reclaimed timer stale', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-street:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const state = setOnlineRoomTurnDeadline(fixture.state, Date.now() - 1)
  await fixture.runtime.create(state)
  await first.schedule(currentJob(state, state.turnDeadlineAt!))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise
  let changed = applyOnlineRoomAction(state, { action: { playerId: 'owner', type: 'call' } })
  changed = applyOnlineRoomAction(changed, { action: { playerId: 'other', type: 'check' } })
  const streetChanged = Object.freeze({ ...changed, pokerTable: advanceTableStreet(changed.pokerTable), turnDeadlineAt: null })
  await fixture.runtime.update(state.roomId, 1, () => streetChanged)
  assert.equal(await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await oldWorker, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.street, 'FLOP')
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('finished hand makes a reclaimed timer stale', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-finished:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  const fixture = runtimeRoom()
  const state = setOnlineRoomTurnDeadline(fixture.state, Date.now() - 1)
  await fixture.runtime.create(state)
  await first.schedule(currentJob(state, state.turnDeadlineAt!))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async job => {
    entered()
    await releasePromise
    return processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: first })
  })
  await enteredPromise
  const actor = state.pokerTable.currentHand!.players.find(player => player.seat === state.pokerTable.currentHand!.currentActor)!
  const folded = applyOnlineRoomAction(state, { action: { playerId: actor.playerId, type: 'fold' } })
  const finished = Object.freeze({ ...folded, pokerTable: advanceTableStreet(folded.pokerTable), turnDeadlineAt: null })
  await fixture.runtime.update(state.roomId, 1, () => finished)
  assert.equal(await second.processDue(job => processAuthenticatedOnlineRoomTimeout(job, { runtime: fixture.runtime, timer: second }), Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await oldWorker, 1)
  const updated = await fixture.runtime.get(state.roomId)
  assert.equal(updated?.state.pokerTable.currentHand?.street, 'FINISHED')
  await first.disconnect()
  await second.disconnect()
  await fixture.timer.disconnect()
})

test('reclaim works across independent timer service instances', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-cross-instance:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  await first.schedule(currentJob(runningRoom(), Date.now() - 1))
  let firstEntered!: () => void
  const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const oldWorker = first.processDue(async () => {
    firstEntered()
    await releasePromise
    return 'COMPLETED' as const
  })
  await firstEnteredPromise
  let seen = 0
  assert.equal(await second.processDue(async job => { seen += 1; assert.ok(job.claimToken); return 'COMPLETED' as const }, Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await oldWorker, 1)
  assert.equal(seen, 1)
  await first.disconnect()
  await second.disconnect()
})

test('Redis outage does not consume a due job and recovery can process it', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-reclaim-outage:${randomUUID()}:`
  const good = timerWithPrefix(prefix)
  await good.schedule(currentJob(runningRoom(), Date.now() - 1))
  const broken = new OnlineRoomTurnTimerService({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: prefix })
  await assert.rejects(broken.processDue(async () => 'COMPLETED'))
  let seen = 0
  assert.equal(await good.processDue(async () => { seen += 1; return 'COMPLETED' as const }), 1)
  assert.equal(seen, 1)
  await broken.disconnect()
  await good.disconnect()
})

test('successful timeout removes payload, claim and due metadata', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-cleanup-success:${randomUUID()}:`
  const service = timerWithPrefix(prefix)
  await service.schedule(currentJob(runningRoom(), Date.now() - 1))
  assert.equal(await service.processDue(async () => 'COMPLETED' as const), 1)
  const keys = await redis!.keys(`${prefix}*`)
  assert.equal(keys.some(key => key.includes(':job:') || key.includes(':claim:')), false)
  assert.equal(await redis!.zcard(`${prefix}index`), 0)
  await service.disconnect()
})

test('stale timeout removes its payload and claim metadata', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-cleanup-stale:${randomUUID()}:`
  const service = timerWithPrefix(prefix)
  await service.schedule(currentJob(runningRoom(), Date.now() - 1))
  assert.equal(await service.processDue(async () => 'STALE' as const), 1)
  const keys = await redis!.keys(`${prefix}*`)
  assert.equal(keys.some(key => key.includes(':job:') || key.includes(':claim:')), false)
  assert.equal(await redis!.zcard(`${prefix}index`), 0)
  await service.disconnect()
})

test('replaced timers do not leak old jobs or claims', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-replaced-cleanup:${randomUUID()}:`
  const service = timerWithPrefix(prefix)
  const state = runningRoom()
  await service.schedule(currentJob(state, Date.now() + 10_000))
  await service.schedule(currentJob(state, Date.now() + 20_000))
  const keys = await redis!.keys(`${prefix}job:*`)
  assert.equal(keys.length, 1)
  assert.equal(await redis!.zcard(`${prefix}claims`), 0)
  await service.clear(state.roomId)
  await service.disconnect()
})

test('process restart can reclaim a claim left by the previous worker', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-restart-reclaim:${randomUUID()}:`
  const first = timerWithPrefix(prefix)
  const second = timerWithPrefix(prefix)
  await first.schedule(currentJob(runningRoom(), Date.now() - 1))
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const releasePromise = new Promise<void>(resolve => { release = resolve })
  const crashed = first.processDue(async () => { entered(); await releasePromise; return 'COMPLETED' as const })
  await enteredPromise
  await first.disconnect()
  assert.equal(await second.processDue(async () => 'COMPLETED' as const, Date.now() + (ONLINE_ROOM_TURN_TIMER_CLAIM_LEASE_SECONDS + 1) * 1_000), 1)
  release()
  assert.equal(await crashed, 1)
  await second.disconnect()
})

test('claim index does not retain completed jobs without bound', { skip: !isolated }, async () => {
  const prefix = `pocker:test:turn-claim-retention:${randomUUID()}:`
  const service = timerWithPrefix(prefix)
  for (let index = 0; index < 3; index += 1) {
    await service.schedule(currentJob(runningRoom(), Date.now() - 1))
    await service.processDue(async () => 'COMPLETED' as const)
  }
  assert.equal(await redis!.zcard(`${prefix}claims`), 0)
  assert.equal((await redis!.keys(`${prefix}claim:*`)).length, 0)
  await service.disconnect()
})
