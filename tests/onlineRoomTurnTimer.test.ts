import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { OnlineRoomRuntimeStore } from '../server/services/onlineRoomRuntimeStore'
import { processAuthenticatedOnlineRoomTimeout } from '../server/services/onlineRoomApiService'
import {
  OnlineRoomTurnTimerService,
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
  const service = new OnlineRoomTurnTimerService({ redis: redis!, keyPrefix: `pocker:test:turn-timer:${randomUUID()}:`, pollIntervalMs: 50 })
  return service
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
