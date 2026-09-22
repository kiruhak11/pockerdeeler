import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { createOnlineRoom } from '../server/utils/pokerOnlineRoom'
import { OnlineRoomRuntimeStore, OnlineRoomRuntimeStoreError } from '../server/services/onlineRoomRuntimeStore'
import {
  ONLINE_ROOM_MAX_MESSAGE_BYTES,
  ONLINE_ROOM_PROTOCOL_VERSION,
  parseOnlineRoomClientMessage
} from '../server/ws/onlineRoomProtocol'
import {
  parseOnlineRoomChangedSignal,
  serializeOnlineRoomChangedSignal
} from '../server/services/onlineRoomRealtimeService'

const redisUrl = process.env.ONLINE_ROOM_TEST_REDIS_URL
const isolated = Boolean(redisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(redisUrl))
const redis = isolated ? new Redis(redisUrl!, { lazyConnect: true }) : undefined
const prefixes: string[] = []

function roomState() {
  return createOnlineRoom({
    roomId: `ws-room-${randomUUID()}`,
    roomCode: 'ABC234',
    ownerId: 'owner',
    ownerStack: 1000,
    smallBlind: 5,
    bigBlind: 10
  })
}

function protocolMessage(value: unknown): string {
  return JSON.stringify(value)
}

test('versioned PING is accepted', () => {
  assert.deepEqual(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PING' })), { version: 1, type: 'PING' })
})

test('versioned REQUEST_STATE is accepted', () => {
  assert.deepEqual(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'REQUEST_STATE' })), { version: 1, type: 'REQUEST_STATE' })
})

test('versioned START_HAND is accepted', () => {
  assert.deepEqual(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'START_HAND', expectedTableStateVersion: 4 })), { version: 1, type: 'START_HAND', expectedTableStateVersion: 4 })
})

test('versioned PLAYER_ACTION is accepted', () => {
  const parsed = parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 4, action: { type: 'bet', amount: 20 } }))
  assert.deepEqual(parsed, { version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 4, action: { type: 'bet', amount: 20 } })
})

test('old protocol version is rejected', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 0, type: 'PING' })), null)
})

test('future protocol version is rejected', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: ONLINE_ROOM_PROTOCOL_VERSION + 1, type: 'PING' })), null)
})

test('unknown command is rejected', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'EXECUTE' })), null)
})

test('malformed JSON is rejected without throwing', () => {
  assert.doesNotThrow(() => assert.equal(parseOnlineRoomClientMessage('{'), null))
})

test('unknown fields are rejected', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PING', playerId: 'spoof' })), null)
})

test('PLAYER_ACTION cannot supply playerId', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', playerId: 'spoof', expectedTableStateVersion: 0, action: { type: 'check' } })), null)
})

test('PLAYER_ACTION requires bounded actionId', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'short', expectedTableStateVersion: 0, action: { type: 'check' } })), null)
})

test('PLAYER_ACTION requires non-negative table version', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: -1, action: { type: 'check' } })), null)
})

test('bet requires an amount', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 0, action: { type: 'bet' } })), null)
})

test('check cannot include an amount', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 0, action: { type: 'check', amount: 1 } })), null)
})

test('raise rejects a non-positive amount', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 0, action: { type: 'raise', amount: 0 } })), null)
})

test('all-in does not accept a client amount', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'PLAYER_ACTION', actionId: 'action-123', expectedTableStateVersion: 0, action: { type: 'all-in', amount: 100 } })), null)
})

test('room credentials and owner fields are not protocol commands', () => {
  assert.equal(parseOnlineRoomClientMessage(protocolMessage({ version: 1, type: 'START_HAND', expectedTableStateVersion: 0, ownerId: 'spoof', privateJoinSecret: 'secret' })), null)
})

test('message size is bounded', () => {
  assert.equal(parseOnlineRoomClientMessage('x'.repeat(ONLINE_ROOM_MAX_MESSAGE_BYTES + 1)), null)
})

test('signal serializes only room identity and public versions', () => {
  const payload = serializeOnlineRoomChangedSignal({ type: 'ROOM_CHANGED', roomId: 'room-1', roomCode: 'ABC234', roomVersion: 3, tableStateVersion: 9 })
  assert.deepEqual(JSON.parse(payload), { type: 'ROOM_CHANGED', roomId: 'room-1', roomCode: 'ABC234', roomVersion: 3, tableStateVersion: 9 })
  assert.equal(payload.includes('holeCards'), false)
  assert.equal(payload.includes('burnCards'), false)
  assert.equal(payload.includes('privateJoinSecret'), false)
})

test('valid room change signal parses', () => {
  assert.deepEqual(parseOnlineRoomChangedSignal('{"type":"ROOM_CHANGED","roomId":"room-1","roomCode":"ABC234","roomVersion":3,"tableStateVersion":9}'), { type: 'ROOM_CHANGED', roomId: 'room-1', roomCode: 'ABC234', roomVersion: 3, tableStateVersion: 9 })
})

test('invalid room change signal is ignored', () => {
  assert.equal(parseOnlineRoomChangedSignal('{"type":"ROOM_CHANGED","roomId":"room-1","roomCode":"ABC234","roomVersion":-1,"tableStateVersion":9}'), null)
})

test('raw internal hand state is not a valid signal', () => {
  assert.equal(parseOnlineRoomChangedSignal('{"type":"ROOM_CHANGED","roomId":"room-1","roomCode":"ABC234","roomVersion":1,"tableStateVersion":1,"deck":[]}'), null)
})

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

function runtimeFor(state: ReturnType<typeof roomState>): OnlineRoomRuntimeStore {
  const keyPrefix = `pocker:test:online-ws:${randomUUID()}:`
  prefixes.push(keyPrefix)
  return new OnlineRoomRuntimeStore({ redis: redis!, keyPrefix, ttlSeconds: 60, actionTtlSeconds: 60 })
}

function incrementRoomVersion(state: ReturnType<typeof roomState>) {
  return Object.freeze({ ...state, roomVersion: state.roomVersion + 1 })
}

test('Redis runtime action applies once', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  const result = await store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion)
  assert.equal(result.duplicate, false)
  assert.equal(result.record.runtimeRevision, 2)
  assert.equal(result.record.state.roomVersion, 2)
})

test('exact action retry returns duplicate without another mutation', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  const first = await store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion)
  const retry = await store.updateWithAction(state.roomId, first.record.runtimeRevision, 'owner', 'action-123', 'check-v0', () => { throw new Error('must not execute duplicate updater') })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.record.runtimeRevision, first.record.runtimeRevision)
  assert.equal(retry.record.state.roomVersion, 2)
})

test('same action id with another fingerprint is rejected', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  await store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion)
  await assert.rejects(store.updateWithAction(state.roomId, 2, 'owner', 'action-123', 'fold-v0', incrementRoomVersion), (error: unknown) => error instanceof OnlineRoomRuntimeStoreError && error.code === 'ACTION_CONFLICT')
})

test('different players may use the same action id independently', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  const first = await store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'owner-v0', incrementRoomVersion)
  const second = await store.updateWithAction(state.roomId, first.record.runtimeRevision, 'other', 'action-123', 'other-v1', incrementRoomVersion)
  assert.equal(second.duplicate, false)
  assert.equal(second.record.state.roomVersion, 3)
})

test('concurrent duplicate actions have one winning mutation', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  const results = await Promise.allSettled([
    store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion),
    store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion)
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter(result => result.status === 'fulfilled' && !result.value.duplicate).length, 1)
  const current = await store.get(state.roomId)
  assert.equal(current?.state.roomVersion, 2)
})

test('concurrent different actions cannot both win the same revision', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  const results = await Promise.allSettled([
    store.updateWithAction(state.roomId, 1, 'owner', 'action-a', 'a', incrementRoomVersion),
    store.updateWithAction(state.roomId, 1, 'owner', 'action-b', 'b', incrementRoomVersion)
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
})

test('action metadata has bounded retention', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await store.create(state)
  await store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion)
  const keys = await redis!.keys(`${prefixes.at(-1)}*action*`)
  assert.equal(keys.length, 1)
  assert.ok((await redis!.ttl(keys[0]!)) > 0)
})

test('runtime failure never falls back to local action state', { skip: !isolated }, async () => {
  const state = roomState()
  const store = runtimeFor(state)
  await assert.rejects(store.updateWithAction(state.roomId, 1, 'owner', 'action-123', 'check-v0', incrementRoomVersion), (error: unknown) => error instanceof OnlineRoomRuntimeStoreError && error.code === 'ROOM_NOT_FOUND')
})
