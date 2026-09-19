import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { createPinia, setActivePinia, defineStore } from 'pinia'
import { randomUUID } from 'node:crypto'
import { reconnectDelay } from '../app/types/realtime'
import { playerActionSchema } from '../server/utils/validation'
import { registerRoomPeer, finishRoomPeerSync, broadcastRoomState, unregisterRoomPeer, revokeRoomParticipant } from '../server/ws/roomHub'
import type { Peer } from 'crossws'
import type { RoomState } from '../app/types/room'

function loadModule(path: string, globals: Record<string, unknown> = {}, imports: Record<string, unknown> = {}) {
  const source = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const context = vm.createContext({ ...vue, defineStore, exports: {}, ...globals,
    require: (name: string) => { if (!(name in imports)) throw new Error('Unexpected import ' + name); return imports[name] } })
  new vm.Script(source, { filename: path }).runInContext(context)
  return context.exports as any
}
function state(revision: number): RoomState {
  return { room: { id: 'room-id', code: 'TEST', revision }, players: [], currentHand: null, currentSession: null,
    actions: [], pendingActions: [], chatMessages: [], lastDistribution: null } as unknown as RoomState
}
function peer() {
  const messages: any[] = [], closes: number[] = []
  return { messages, closes, peer: { send: (value: string) => messages.push(JSON.parse(value)), close: (code: number) => closes.push(code) } as unknown as Peer }
}

test('handshake buffers the newest full snapshot and never rolls back after registration', () => {
  const p = peer()
  registerRoomPeer('TEST', p.peer, 'actor', true)
  broadcastRoomState('TEST', state(12))
  broadcastRoomState('TEST', state(11))
  assert.equal(p.messages.length, 0)
  finishRoomPeerSync('TEST', p.peer, state(10))
  assert.equal(p.messages[0].type, 'room:joined')
  assert.equal(p.messages[0].state.room.revision, 12)
  broadcastRoomState('TEST', state(9))
  broadcastRoomState('TEST', state(20))
  assert.deepEqual(p.messages.map(m => m.state.room.revision), [12, 20])
  unregisterRoomPeer('TEST', p.peer)
})

test('revocation during snapshot load cannot restore the subscription', () => {
  const p = peer()
  registerRoomPeer('TEST', p.peer, 'actor', true)
  revokeRoomParticipant('TEST', 'actor')
  finishRoomPeerSync('TEST', p.peer, state(4))
  broadcastRoomState('TEST', state(5))
  assert.equal(p.messages.length, 0)
  assert.deepEqual(p.closes, [4003])
})

test('backoff is exponential with bounded jitter and a hard 30 second ceiling', () => {
  assert.equal(reconnectDelay(0, () => 0), 500)
  assert.equal(reconnectDelay(1, () => 0), 1000)
  assert.equal(reconnectDelay(4, () => 1), 16000)
  assert.equal(reconnectDelay(500, () => 1), 30000)
})

test('rollout accepts old action clients but validates new hand/revision fields', () => {
  const old = { playerId: randomUUID(), token: 'player-test-token', type: 'call', clientRequestId: randomUUID() }
  assert.equal(playerActionSchema.safeParse(old).success, true)
  assert.equal(playerActionSchema.safeParse({ ...old, handId: randomUUID(), expectedRevision: 9 }).success, true)
  for (const fields of [{ handId: 'not-a-hand' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(playerActionSchema.safeParse({ ...old, ...fields }).success, false)
  }
})

function storeFixture() {
  setActivePinia(createPinia())
  const { useRoomStore } = loadModule('app/stores/room.ts')
  return { useRoomStore, store: useRoomStore() }
}

test('HTTP and websocket snapshots are monotonic; cached state does not establish freshness', () => {
  const { store } = storeFixture()
  assert.equal(store.setRoomState(state(7)), true)
  assert.equal(store.isStateFresh, false)
  store.setConnectionStatus('connected')
  assert.equal(store.setRoomState(state(6)), false)
  assert.equal(store.room.revision, 7)
  assert.equal(store.setRoomState(state(19)), true)
  store.setConnectionStatus('syncing')
  assert.equal(store.isStateFresh, false)
  assert.equal(store.room.revision, 19)
})

function realtimeFixture() {
  const { store, useRoomStore } = storeFixture()
  const mounts: (() => void)[] = [], unmounts: (() => void)[] = []
  const timeouts = new Map<number, () => void>(), intervals = new Map<number, () => void>()
  const win = new EventTarget() as EventTarget & { location: { protocol: string; host: string } }
  win.location = { protocol: 'http:', host: 'localhost' }
  const doc = new EventTarget() as EventTarget & { visibilityState: string }
  doc.visibilityState = 'visible'
  const nav = { onLine: true }
  const sockets: FakeSocket[] = []
  let timer = 0
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) { sockets.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.onopen?.() }
    snapshot(revision: number, type = 'room:joined') { this.onmessage?.({ data: JSON.stringify({ type, roomCode: 'TEST', state: state(revision) }) }) }
  }
  const { useRoomRealtime } = loadModule('app/composables/useRoomRealtime.ts', {
    onMounted: (fn: () => void) => mounts.push(fn), onBeforeUnmount: (fn: () => void) => unmounts.push(fn),
    useRoomCredentials: () => ({ token: () => 'token' }), window: win, document: doc, navigator: nav, WebSocket: FakeSocket,
    setTimeout: (fn: () => void) => { timeouts.set(++timer, fn); return timer }, clearTimeout: (id: number) => timeouts.delete(id),
    setInterval: (fn: () => void) => { intervals.set(++timer, fn); return timer }, clearInterval: (id: number) => intervals.delete(id)
  }, { '~/types/realtime': { reconnectDelay }, '~/stores/room': { useRoomStore } })
  const scope = vue.effectScope()
  const controller = scope.run(() => useRoomRealtime('TEST'))
  mounts.forEach(fn => fn())
  return { store, controller, sockets, win, doc, nav, timeouts, intervals, destroy: () => { unmounts.forEach(fn => fn()); scope.stop() } }
}

test('one socket per controller, foreground/BFCache recovery and stale-socket callbacks ignored', () => {
  const f = realtimeFixture()
  try {
    f.controller.connect(); f.controller.connect()
    assert.equal(f.sockets.length, 1)
    const first = f.sockets[0]!
    first.open()
    assert.equal(f.store.connectionStatus, 'syncing')
    first.snapshot(3)
    assert.equal(f.store.isStateFresh, true)
    const staleCallback = first.onmessage!
    f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(f.store.isStateFresh, false)
    assert.equal(first.readyState, 3)
    f.doc.visibilityState = 'visible'; f.win.dispatchEvent(new Event('pageshow'))
    assert.equal(f.sockets.length, 2)
    staleCallback({ data: JSON.stringify({ type: 'room:joined', roomCode: 'TEST', state: state(99) }) })
    assert.equal(f.store.room.revision, 3)
    const second = f.sockets[1]!
    second.open(); second.snapshot(8)
    assert.equal(f.store.room.revision, 8)
    f.nav.onLine = false; f.win.dispatchEvent(new Event('offline'))
    assert.equal(f.store.isStateFresh, false)
    assert.equal(f.timeouts.size, 0)
    f.nav.onLine = true; f.win.dispatchEvent(new Event('online'))
    assert.equal(f.sockets.length, 3)
  } finally { f.destroy() }
  assert.equal(f.intervals.size, 0)
  assert.equal(f.timeouts.size, 0)
  f.win.dispatchEvent(new Event('pageshow'))
  assert.equal(f.sockets.length, 3)
})

test('expired authorization stops retries without erasing membership or cached stacks', () => {
  const f = realtimeFixture()
  try {
    f.sockets[0]!.open(); f.sockets[0]!.snapshot(5)
    f.sockets[0]!.onclose!({ code: 4003 })
    assert.equal(f.store.connectionStatus, 'unauthorized')
    assert.equal(f.store.room.revision, 5)
    assert.equal(f.timeouts.size, 0)
    f.win.dispatchEvent(new Event('online')); f.win.dispatchEvent(new Event('pageshow'))
    assert.equal(f.sockets.length, 1)
  } finally { f.destroy() }
})

test('older handshake cannot mark a newer HTTP snapshot fresh', () => {
  const f = realtimeFixture()
  try {
    f.store.setRoomState(state(10))
    f.sockets[0]!.open(); f.sockets[0]!.snapshot(9)
    assert.equal(f.store.isStateFresh, false)
    assert.equal(f.store.room.revision, 10)
    assert.equal(f.timeouts.size, 1)
  } finally { f.destroy() }
})

function actionFixture(fetcher: (url: string, options: any) => Promise<unknown>, storage = new Map<string, string>()) {
  const { store, useRoomStore } = storeFixture()
  const session = { roomCode: 'TEST', playerId: 'actor', token: 'player-token' }
  const mounts: (() => void)[] = [], unmounts: (() => void)[] = []
  const win = new EventTarget()
  const timers = new Map<number, () => void>()
  let timer = 0
  const { usePlayerRoom } = loadModule('app/composables/usePlayerRoom.ts', {
    $fetch: fetcher, window: win, navigator: { onLine: true },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    useRoomCredentials: () => ({ headers: () => ({}) }),
    onMounted: (fn: () => void) => mounts.push(fn), onBeforeUnmount: (fn: () => void) => unmounts.push(fn),
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer }, clearTimeout: (id: number) => timers.delete(id)
  }, {
    '~/stores/room': { useRoomStore }, '~/stores/playerSession': { usePlayerSessionStore: () => session },
    '~/stores/account': { useAccountStore: () => ({}) }, '~/utils/idempotency': { createClientRequestId: () => randomUUID() }
  })
  store.setRoomState({ ...state(5), currentHand: { id: 'hand', status: 'active' } } as RoomState)
  const scope = vue.effectScope(), controller = scope.run(() => usePlayerRoom('TEST'))
  mounts.forEach(fn => fn())
  return { store, controller, storage, destroy: () => { unmounts.forEach(fn => fn()); scope.stop() } }
}

test('offline/stale action is never queued and simultaneous taps produce only one POST', async () => {
  const calls: any[] = []
  let complete!: (value: unknown) => void
  const f = actionFixture(async (url, options) => { calls.push({ url, options }); return new Promise(resolve => { complete = resolve }) })
  try {
    await assert.rejects(f.controller.sendAction({ type: 'call', amount: 0 }), /Обновляем игру/)
    assert.equal(calls.length, 0)
    assert.equal(f.storage.size, 0)
    f.store.setConnectionStatus('connected')
    const first = f.controller.sendAction({ type: 'call', amount: 0 })
    await assert.rejects(f.controller.sendAction({ type: 'call', amount: 0 }), /предыдущее действие/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.body.handId, 'hand')
    assert.equal(calls[0].options.body.expectedRevision, 5)
    assert.equal(calls[0].options.retry, 0)
    complete({ success: true, action: { status: 'applied' } })
    await first
    assert.equal(f.storage.size, 0)
  } finally { f.destroy() }
})

test('lost reply persists the original ID across reload and resolves via read-only status', async () => {
  let id = ''
  const f = actionFixture(async (_url, options) => { id = options.body.clientRequestId; throw new Error('network lost') })
  f.store.setConnectionStatus('connected')
  await assert.rejects(f.controller.sendAction({ type: 'call', amount: 0 }), /network lost/)
  assert.equal(f.store.uncertainAction.clientRequestId, id)
  assert.equal(f.storage.size, 1)
  f.destroy()
  const calls: any[] = []
  const restored = actionFixture(async (url, options) => {
    calls.push({ url, options })
    return { action: { status: 'applied' }, checkedRevision: 6, state: state(6) }
  }, f.storage)
  try {
    assert.equal(restored.store.uncertainAction.clientRequestId, id)
    restored.store.setConnectionStatus('connected')
    await restored.controller.recoverAction()
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /action-status$/)
    assert.equal(calls[0].options.query.clientRequestId, id)
    assert.equal(calls[0].options.method, undefined)
    assert.equal(restored.store.uncertainAction, null)
    assert.equal(restored.storage.size, 0)
  } finally { restored.destroy() }
})

test('a missing ID is not treated as rejected while its original version can still apply', async () => {
  const saved = new Map([['poker-uncertain-action-v1:TEST:actor', JSON.stringify({ roomCode: 'TEST', playerId: 'actor', handId: 'hand', clientRequestId: 'uncertain', expectedRevision: 5, type: 'call', amount: 0 })]])
  let checkedRevision = 5
  const f = actionFixture(async () => ({ action: null, checkedRevision, state: state(8) }), saved)
  try {
    f.store.setConnectionStatus('connected')
    await f.controller.recoverAction()
    assert.ok(f.store.uncertainAction, 'Later snapshot alone is not proof: a POST may commit between status and snapshot reads')
    checkedRevision = 8
    await vue.nextTick()
    await new Promise(resolve => setImmediate(resolve))
    await f.controller.recoverAction()
    assert.equal(f.store.uncertainAction, null)
  } finally { f.destroy() }
})
