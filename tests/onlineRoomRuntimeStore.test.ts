import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  OnlineRoomRuntimeStore,
  OnlineRoomRuntimeStoreError,
  serializeOnlineRoomRuntimeState
} from '../server/services/onlineRoomRuntimeStore'
import {
  applyOnlineRoomAction,
  createOnlineRoom,
  joinOnlineRoom,
  leaveOnlineRoom,
  setOnlineRoomReady,
  setOnlineRoomSittingOut,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState,
  type OnlineRoomState
} from '../server/utils/pokerOnlineRoom'
import { advanceStreet } from '../server/utils/pokerHandState'
import { createStandardDeck } from '../server/utils/pokerDeck'

const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const prefixes: string[] = []

function store(): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:online-room-runtime:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 60 })
}

function room(options: { ownerStack?: number; secondStack?: number } = {}): OnlineRoomState {
  let state = createOnlineRoom({
    roomId: randomUUID(),
    roomCode: 'AB2345',
    ownerId: 'owner',
    ownerStack: options.ownerStack ?? 100,
    smallBlind: 5,
    bigBlind: 10
  })
  state = joinOnlineRoom(state, { playerId: 'player-2', stack: options.secondStack ?? 100, seat: 2 })
  return state
}

function ready(state: OnlineRoomState): OnlineRoomState {
  let next = setOnlineRoomReady(state, 'owner', true)
  next = setOnlineRoomReady(next, 'player-2', true)
  return next
}

function activeRoom(options: { ownerStack?: number; secondStack?: number } = {}): OnlineRoomState {
  return startOnlineRoomHand(ready(room(options)), { deck: createStandardDeck() })
}

function withHand(state: OnlineRoomState, hand: NonNullable<OnlineRoomState['pokerTable']['currentHand']>): OnlineRoomState {
  return Object.freeze({
    ...state,
    pokerTable: Object.freeze({ ...state.pokerTable, currentHand: hand })
  })
}

test.before(async () => {
  if (isolated) {
    await redis!.connect()
    await redis!.flushdb()
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
})

test('save and load an empty ONLINE room', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  const loaded = await runtime.get(state.roomId)
  assert.equal(created.runtimeRevision, 1)
  assert.deepEqual(loaded, created)
})

test('save and load a room with seated players', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  const loaded = await runtime.get(state.roomId)
  assert.deepEqual(loaded?.state.pokerTable.players, state.pokerTable.players)
  assert.deepEqual(loaded?.state.pokerTable.seats, state.pokerTable.seats)
})

test('save and load an active hand', { skip: !isolated }, async () => {
  const state = activeRoom()
  const runtime = store()
  await runtime.create(state)
  const loaded = await runtime.get(state.roomId)
  assert.equal(loaded?.state.pokerTable.currentHand?.street, 'PREFLOP')
  assert.equal(loaded?.state.pokerTable.currentHand?.currentActor, state.pokerTable.currentHand?.currentActor)
})

test('hole cards survive an internal round-trip', { skip: !isolated }, async () => {
  const state = activeRoom()
  const runtime = store()
  await runtime.create(state)
  const loaded = await runtime.get(state.roomId)
  assert.deepEqual(loaded?.state.pokerTable.currentHand?.players.map(player => player.holeCards), state.pokerTable.currentHand?.players.map(player => player.holeCards))
})

test('deck and burn cards survive an internal round-trip', { skip: !isolated }, async () => {
  const started = activeRoom({ ownerStack: 5, secondStack: 10 })
  const hand = started.pokerTable.currentHand!
  const advanced = advanceStreet(hand)
  const state = withHand(started, advanced)
  const runtime = store()
  await runtime.create(state)
  const loaded = await runtime.get(state.roomId)
  assert.deepEqual(loaded?.state.pokerTable.currentHand?.burnCards, advanced.burnCards)
  assert.deepEqual(loaded?.state.pokerTable.currentHand?.deck.availableCards, advanced.deck.availableCards)
})

test('roomVersion is preserved', { skip: !isolated }, async () => {
  const state = setOnlineRoomReady(room(), 'owner', true)
  const runtime = store()
  await runtime.create(state)
  assert.equal((await runtime.get(state.roomId))?.state.roomVersion, state.roomVersion)
})

test('table stateVersion is preserved', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  assert.equal((await runtime.get(state.roomId))?.state.pokerTable.stateVersion, state.pokerTable.stateVersion)
})

test('runtimeRevision increments after every successful update', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  const updated = await runtime.update(state.roomId, created.runtimeRevision, current => setOnlineRoomReady(current, 'owner', true))
  const updatedAgain = await runtime.update(state.roomId, updated.runtimeRevision, current => setOnlineRoomSittingOut(current, 'owner', true))
  assert.equal(updated.runtimeRevision, 2)
  assert.equal(updatedAgain.runtimeRevision, 3)
})

test('atomic update succeeds with the correct revision', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  const updated = await runtime.update(state.roomId, created.runtimeRevision, current => joinOnlineRoom(current, { playerId: 'player-3', stack: 100, seat: 3 }))
  assert.equal(updated.state.pokerTable.players.length, 3)
  assert.equal(updated.runtimeRevision, 2)
})

test('stale runtime revision is rejected', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  await runtime.update(state.roomId, 1, current => setOnlineRoomReady(current, 'owner', true))
  await assert.rejects(
    runtime.update(state.roomId, 1, current => setOnlineRoomReady(current, 'player-2', true)),
    error => error instanceof OnlineRoomRuntimeStoreError && error.code === 'STALE_STATE'
  )
})

test('two concurrent updates allow only one writer', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  const results = await Promise.allSettled([
    runtime.update(state.roomId, 1, current => setOnlineRoomReady(current, 'owner', true)),
    runtime.update(state.roomId, 1, current => setOnlineRoomSittingOut(current, 'owner', true))
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal((await runtime.get(state.roomId))?.runtimeRevision, 2)
})

test('losing writer cannot overwrite the winning update', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  const results = await Promise.allSettled([
    runtime.update(state.roomId, 1, current => setOnlineRoomReady(current, 'owner', true)),
    runtime.update(state.roomId, 1, current => setOnlineRoomConnected(current, 'player-2', false))
  ])
  const winning = results.find(result => result.status === 'fulfilled')
  assert.ok(winning && winning.status === 'fulfilled')
  const finalState = (await runtime.get(state.roomId))!.state
  assert.deepEqual(finalState, winning.value.state)
})

test('join mutation persists through the runtime store', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  await runtime.update(state.roomId, created.runtimeRevision, current => joinOnlineRoom(current, { playerId: 'player-3', stack: 100, seat: 3 }))
  assert.ok((await runtime.get(state.roomId))?.state.pokerTable.players.some(player => player.playerId === 'player-3'))
})

test('leave mutation persists through the runtime store', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  const left = await runtime.update(state.roomId, created.runtimeRevision, current => leaveOnlineRoom(current, 'player-2'))
  assert.equal(left.state.pokerTable.players.some(player => player.playerId === 'player-2'), false)
})

test('ready and sitting-out mutations persist', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  const created = await runtime.create(state)
  const readyState = await runtime.update(state.roomId, created.runtimeRevision, current => setOnlineRoomReady(current, 'owner', true))
  const sittingOutState = await runtime.update(state.roomId, readyState.runtimeRevision, current => setOnlineRoomSittingOut(current, 'owner', true))
  assert.equal(sittingOutState.state.pokerTable.players.find(player => player.playerId === 'owner')?.sittingOut, true)
})

test('start-hand mutation persists', { skip: !isolated }, async () => {
  const state = ready(room())
  const runtime = store()
  const created = await runtime.create(state)
  const started = await runtime.update(state.roomId, created.runtimeRevision, current => startOnlineRoomHand(current, { deck: createStandardDeck() }))
  assert.equal((await runtime.get(state.roomId))?.state.pokerTable.currentHand?.street, 'PREFLOP')
  assert.equal(started.runtimeRevision, 2)
})

test('poker action mutation persists', { skip: !isolated }, async () => {
  const state = activeRoom()
  const actor = state.pokerTable.currentHand!.players.find(player => player.seat === state.pokerTable.currentHand!.currentActor)!
  const runtime = store()
  const created = await runtime.create(state)
  const updated = await runtime.update(state.roomId, created.runtimeRevision, current => applyOnlineRoomAction(current, { action: { playerId: actor.playerId, type: 'call' } }))
  assert.notEqual(updated.state.pokerTable.currentHand?.currentActor, actor.seat)
})

test('a second instance sees state written by the first', { skip: !isolated }, async () => {
  const state = room()
  const first = store()
  const second = new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix: first.keyFor(state.roomId).replace(state.roomId, ''), ttlSeconds: 60 })
  await first.create(state)
  const created = await first.get(state.roomId)
  await first.update(state.roomId, created!.runtimeRevision, current => setOnlineRoomReady(current, 'owner', true))
  assert.equal((await second.get(state.roomId))?.state.pokerTable.players.find(player => player.playerId === 'owner')?.ready, true)
})

test('Redis failure returns a controlled error', { skip: !isolated }, async () => {
  const unavailable = new OnlineRoomRuntimeStore({ redisUrl: 'redis://127.0.0.1:1/15', keyPrefix: `pocker:test:unavailable:${randomUUID()}:` })
  await assert.rejects(unavailable.get('missing-room'), error => error instanceof OnlineRoomRuntimeStoreError && error.code === 'REDIS_UNAVAILABLE')
  await unavailable.disconnect()
})

test('corrupted Redis payload returns a controlled error', { skip: !isolated }, async () => {
  const runtime = store()
  const roomId = randomUUID()
  await redis!.set(runtime.keyFor(roomId), '{not-json', 'EX', 60)
  await assert.rejects(runtime.get(roomId), error => error instanceof OnlineRoomRuntimeStoreError && error.code === 'CORRUPTED_STATE')
})

test('safe snapshot still hides other hole cards', { skip: !isolated }, async () => {
  const state = activeRoom()
  const runtime = store()
  await runtime.create(state)
  const loaded = (await runtime.get(state.roomId))!.state
  const safe = toPlayerSafeOnlineRoomState(loaded, 'owner')
  assert.equal(safe.pokerTable.currentHand!.players.find(player => player.playerId === 'player-2')!.holeCards.length, 0)
})

test('safe snapshot hides deck and burn cards', { skip: !isolated }, async () => {
  const state = activeRoom()
  const runtime = store()
  await runtime.create(state)
  const safe = toPlayerSafeOnlineRoomState((await runtime.get(state.roomId))!.state, 'owner') as Record<string, unknown>
  assert.equal('deck' in safe, false)
  assert.equal('burnCards' in safe, false)
  assert.equal('deck' in (safe.pokerTable.currentHand as object), false)
  assert.equal('burnCards' in (safe.pokerTable.currentHand as object), false)
})

test('active room TTL remains present during normal activity', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  const waitingTtlBefore = await redis!.ttl(runtime.keyFor(state.roomId))
  await runtime.get(state.roomId)
  const waitingTtlAfter = await redis!.ttl(runtime.keyFor(state.roomId))
  assert.ok(waitingTtlBefore > 0)
  assert.ok(waitingTtlAfter > 0)

  const active = activeRoom()
  const activeRuntime = store()
  await activeRuntime.create(active)
  assert.equal(await redis!.ttl(activeRuntime.keyFor(active.roomId)), -1)
  assert.equal((await activeRuntime.get(active.roomId))?.state.pokerTable.currentHand?.street, 'PREFLOP')
})

test('persistent metadata remains outside runtime state', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  const payload = await redis!.get(runtime.keyFor(state.roomId))
  assert.ok(payload)
  assert.match(payload!, /"pokerTable"/)
  assert.equal(payload!.includes('roomCodeRegistry'), false)
})

test('serializer is explicit and does not use runtime object references', { skip: !isolated }, async () => {
  const state = activeRoom()
  const payload = serializeOnlineRoomRuntimeState(state)
  const parsed = JSON.parse(payload) as Record<string, unknown>
  assert.equal(typeof parsed.state, 'object')
  assert.equal((parsed.state as Record<string, unknown>).pokerTable !== state.pokerTable, true)
})

test('controlled updater errors do not become Redis success', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  await assert.rejects(runtime.update(state.roomId, 1, () => { throw new Error('domain update rejected') }), /domain update rejected/)
  assert.equal((await runtime.get(state.roomId))?.runtimeRevision, 1)
})

test('close/remove requires the current revision and removes runtime state', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  await assert.rejects(runtime.close(state.roomId, 2), error => error instanceof OnlineRoomRuntimeStoreError && error.code === 'STALE_STATE')
  await runtime.remove(state.roomId, 1)
  assert.equal(await runtime.get(state.roomId), null)
})

test('duplicate runtime create is rejected without replacing the original state', { skip: !isolated }, async () => {
  const state = room()
  const runtime = store()
  await runtime.create(state)
  await assert.rejects(runtime.create({ ...state, roomVersion: 99 }), error => error instanceof OnlineRoomRuntimeStoreError && error.code === 'ROOM_EXISTS')
  assert.equal((await runtime.get(state.roomId))?.state.roomVersion, state.roomVersion)
})
