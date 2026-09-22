import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  OnlineRoomRealtimeBus,
  ONLINE_ROOM_REALTIME_SUBSCRIBER_STATES,
  parseOnlineRoomChangedSignal,
  serializeOnlineRoomChangedSignal,
  type OnlineRoomChangedSignal
} from '../server/services/onlineRoomRealtimeService'

type FakeStatus = 'wait' | 'ready' | 'end' | 'close'

class FakeRedisBroker {
  private readonly subscribers = new Map<string, Set<FakeRedis>>()

  add(channel: string, client: FakeRedis): void {
    const bucket = this.subscribers.get(channel) ?? new Set<FakeRedis>()
    bucket.add(client)
    this.subscribers.set(channel, bucket)
  }

  remove(client: FakeRedis): void {
    for (const [channel, bucket] of this.subscribers) {
      bucket.delete(client)
      if (bucket.size === 0) this.subscribers.delete(channel)
    }
  }

  publish(channel: string, payload: string): number {
    const bucket = this.subscribers.get(channel)
    if (!bucket) return 0
    for (const client of bucket) client.emit('message', channel, payload)
    return bucket.size
  }
}

class FakeRedis extends EventEmitter {
  status: FakeStatus = 'wait'
  available = true
  connectCalls = 0
  subscribeCalls = 0
  private readonly broker: FakeRedisBroker

  constructor(broker: FakeRedisBroker) {
    super()
    this.broker = broker
  }

  async connect(): Promise<void> {
    this.connectCalls += 1
    if (!this.available) {
      this.status = 'end'
      this.emit('end')
      throw new Error('Redis unavailable')
    }
    this.status = 'ready'
    this.emit('ready')
  }

  async subscribe(channel: string): Promise<number> {
    if (this.status !== 'ready' || !this.available) throw new Error('Redis unavailable')
    this.subscribeCalls += 1
    this.broker.add(channel, this)
    return this.subscribeCalls
  }

  async publish(channel: string, payload: string): Promise<number> {
    if (this.status !== 'ready' || !this.available) throw new Error('Redis unavailable')
    return this.broker.publish(channel, payload)
  }

  disconnect(): void {
    this.broker.remove(this)
    this.status = 'end'
    this.emit('end')
  }

  simulateDisconnect(): void {
    this.disconnect()
  }
}

const signal: OnlineRoomChangedSignal = Object.freeze({
  type: 'ROOM_CHANGED',
  roomId: 'room-1',
  roomCode: 'ABC234',
  roomVersion: 4,
  tableStateVersion: 7
})

function asRedis(client: FakeRedis): Redis {
  return client as unknown as Redis
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for realtime state.'))
      setTimeout(check, 5)
    }
    check()
  })
}

function makeBus(broker = new FakeRedisBroker(), channel = `pocker:test:realtime:${randomUUID()}`) {
  const publisher = new FakeRedis(broker)
  const subscriber = new FakeRedis(broker)
  const bus = new OnlineRoomRealtimeBus({
    publisher: asRedis(publisher),
    subscriber: asRedis(subscriber),
    channel
  })
  return { bus, publisher, subscriber }
}

async function stopBus(bus: OnlineRoomRealtimeBus, publisher: FakeRedis, subscriber: FakeRedis): Promise<void> {
  await bus.disconnect()
  publisher.disconnect()
  subscriber.disconnect()
}

test('signal payload contains only public identity and versions', () => {
  const payload = serializeOnlineRoomChangedSignal(signal)
  assert.deepEqual(parseOnlineRoomChangedSignal(payload), signal)
  assert.equal(payload.includes('holeCards'), false)
  assert.equal(payload.includes('deck'), false)
  assert.equal(payload.includes('burnCards'), false)
  assert.equal(payload.includes('runtimeRevision'), false)
  assert.equal(payload.includes('privateJoinSecret'), false)
})

test('subscriber connects and subscribes exactly once', async () => {
  const fixture = makeBus()
  const unsubscribe = await fixture.bus.subscribe(() => undefined)
  assert.equal(fixture.bus.getSubscriberState(), 'READY')
  assert.equal(fixture.bus.isSubscriberSubscribed(), true)
  assert.equal(fixture.subscriber.connectCalls, 1)
  assert.equal(fixture.subscriber.subscribeCalls, 1)
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('one published signal produces one local callback', async () => {
  const fixture = makeBus()
  let received = 0
  const unsubscribe = await fixture.bus.subscribe(value => {
    assert.deepEqual(value, signal)
    received += 1
  })
  await fixture.bus.publish(signal)
  assert.equal(received, 1)
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('duplicate subscribe calls do not duplicate delivery', async () => {
  const fixture = makeBus()
  let received = 0
  const listener = () => { received += 1 }
  const first = await fixture.bus.subscribe(listener)
  const second = await fixture.bus.subscribe(listener)
  await fixture.bus.publish(signal)
  assert.equal(received, 1)
  assert.equal(fixture.subscriber.subscribeCalls, 1)
  first()
  second()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('Redis disconnect resets READY state and reconnects with resubscribe', async () => {
  const fixture = makeBus()
  let received = 0
  const unsubscribe = await fixture.bus.subscribe(() => { received += 1 })
  fixture.subscriber.simulateDisconnect()
  assert.equal(fixture.bus.getSubscriberState(), 'DISCONNECTED')
  await waitFor(() => fixture.bus.getSubscriberState() === 'READY' && fixture.subscriber.subscribeCalls === 2)
  await fixture.bus.publish(signal)
  assert.equal(received, 1)
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('fatal subscriber error resets state and resubscribes without a second loop', async () => {
  const fixture = makeBus()
  const unsubscribe = await fixture.bus.subscribe(() => undefined)
  fixture.subscriber.emit('error', new Error('transient subscriber failure'))
  await waitFor(() => fixture.bus.getSubscriberState() === 'READY' && fixture.subscriber.subscribeCalls === 2)
  assert.equal(fixture.subscriber.listenerCount('message'), 1)
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('active sockets recover after Redis outage without REQUEST_STATE', async () => {
  const broker = new FakeRedisBroker()
  const channel = `pocker:test:realtime:${randomUUID()}`
  const first = makeBus(broker, channel)
  const second = makeBus(broker, channel)
  let secondReceived = 0
  const firstUnsubscribe = await first.bus.subscribe(() => undefined)
  const secondUnsubscribe = await second.bus.subscribe(() => { secondReceived += 1 })
  second.subscriber.available = false
  second.subscriber.simulateDisconnect()
  await new Promise(resolve => setTimeout(resolve, 20))
  await first.bus.publish(signal)
  assert.equal(secondReceived, 0)
  second.subscriber.available = true
  await waitFor(() => second.bus.getSubscriberState() === 'READY')
  await first.bus.publish({ ...signal, roomVersion: 5 })
  assert.equal(secondReceived, 1)
  firstUnsubscribe()
  secondUnsubscribe()
  await stopBus(first.bus, first.publisher, first.subscriber)
  await stopBus(second.bus, second.publisher, second.subscriber)
})

test('two instances reconnect independently after an outage', async () => {
  const broker = new FakeRedisBroker()
  const channel = `pocker:test:realtime:${randomUUID()}`
  const first = makeBus(broker, channel)
  const second = makeBus(broker, channel)
  const firstUnsubscribe = await first.bus.subscribe(() => undefined)
  const secondUnsubscribe = await second.bus.subscribe(() => undefined)
  first.subscriber.available = false
  second.subscriber.available = false
  first.subscriber.simulateDisconnect()
  second.subscriber.simulateDisconnect()
  first.subscriber.available = true
  second.subscriber.available = true
  await waitFor(() => first.bus.getSubscriberState() === 'READY' && second.bus.getSubscriberState() === 'READY')
  assert.equal(first.subscriber.subscribeCalls, 2)
  assert.equal(second.subscriber.subscribeCalls, 2)
  firstUnsubscribe()
  secondUnsubscribe()
  await stopBus(first.bus, first.publisher, first.subscriber)
  await stopBus(second.bus, second.publisher, second.subscriber)
})

test('startup without Redis keeps retrying with bounded backoff', async () => {
  const fixture = makeBus()
  fixture.subscriber.available = false
  const subscription = fixture.bus.subscribe(() => undefined)
  await assert.rejects(subscription)
  assert.equal(fixture.bus.getSubscriberState(), 'DISCONNECTED')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fixture.subscriber.connectCalls, 1)
  fixture.subscriber.available = true
  await waitFor(() => fixture.bus.getSubscriberState() === 'READY')
  assert.ok(fixture.subscriber.connectCalls >= 2)
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('repeated Redis outages do not add listeners or duplicate callbacks', async () => {
  const fixture = makeBus()
  let received = 0
  const unsubscribe = await fixture.bus.subscribe(() => { received += 1 })
  const baseline = fixture.subscriber.listenerCount('message')
  for (let index = 0; index < 3; index += 1) {
    fixture.subscriber.available = false
    fixture.subscriber.simulateDisconnect()
    fixture.subscriber.available = true
    await waitFor(() => fixture.bus.getSubscriberState() === 'READY')
  }
  assert.equal(fixture.subscriber.listenerCount('message'), baseline)
  await fixture.bus.publish(signal)
  assert.equal(received, 1)
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('publisher failure does not roll back authoritative state and recovers later', async () => {
  const fixture = makeBus()
  const unsubscribe = await fixture.bus.subscribe(() => undefined)
  let authoritativeVersion = 1
  fixture.publisher.available = false
  authoritativeVersion = 2
  await assert.rejects(fixture.bus.publish({ ...signal, roomVersion: authoritativeVersion }))
  assert.equal(authoritativeVersion, 2)
  fixture.publisher.available = true
  await fixture.bus.publish({ ...signal, roomVersion: authoritativeVersion })
  unsubscribe()
  await stopBus(fixture.bus, fixture.publisher, fixture.subscriber)
})

test('shutdown stops reconnect attempts', async () => {
  const fixture = makeBus()
  fixture.subscriber.available = false
  await assert.rejects(fixture.bus.subscribe(() => undefined))
  await fixture.bus.disconnect()
  const calls = fixture.subscriber.connectCalls
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(fixture.subscriber.connectCalls, calls)
  fixture.publisher.disconnect()
  fixture.subscriber.disconnect()
})

test('subscriber lifecycle exposes the bounded state machine', () => {
  assert.deepEqual(ONLINE_ROOM_REALTIME_SUBSCRIBER_STATES, ['DISCONNECTED', 'CONNECTING', 'SUBSCRIBING', 'READY', 'STOPPED'])
})
