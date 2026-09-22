import Redis from 'ioredis'
import { z } from 'zod'

/**
 * Cross-instance notification payload. It is deliberately only a version
 * signal; authoritative state is always read from OnlineRoomRuntimeStore.
 */
export type OnlineRoomChangedSignal = Readonly<{
  type: 'ROOM_CHANGED'
  roomId: string
  roomCode: string
  roomVersion: number
  tableStateVersion: number
}>

export const ONLINE_ROOM_REALTIME_CHANNEL = 'pocker:online-room-realtime:v1'
const ONLINE_ROOM_REALTIME_RECONNECT_BASE_MS = 100
const ONLINE_ROOM_REALTIME_RECONNECT_MAX_MS = 2_000

export const ONLINE_ROOM_REALTIME_SUBSCRIBER_STATES = ['DISCONNECTED', 'CONNECTING', 'SUBSCRIBING', 'READY', 'STOPPED'] as const
export type OnlineRoomRealtimeSubscriberState = typeof ONLINE_ROOM_REALTIME_SUBSCRIBER_STATES[number]

const signalSchema = z.object({
  type: z.literal('ROOM_CHANGED'),
  roomId: z.string().min(1),
  roomCode: z.string().min(1),
  roomVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tableStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict()

type SignalListener = (signal: OnlineRoomChangedSignal) => void | Promise<void>

function redisOptions() {
  return { lazyConnect: true, enableReadyCheck: true, maxRetriesPerRequest: 1, retryStrategy: () => null } as const
}

function assertSignal(signal: OnlineRoomChangedSignal): void {
  if (!signal || signal.type !== 'ROOM_CHANGED' || typeof signal.roomId !== 'string' || signal.roomId.length === 0 ||
      typeof signal.roomCode !== 'string' || signal.roomCode.length === 0 ||
      !Number.isSafeInteger(signal.roomVersion) || signal.roomVersion < 0 ||
      !Number.isSafeInteger(signal.tableStateVersion) || signal.tableStateVersion < 0) {
    throw new Error('Invalid online room change signal.')
  }
}

export function serializeOnlineRoomChangedSignal(signal: OnlineRoomChangedSignal): string {
  assertSignal(signal)
  return JSON.stringify({
    type: 'ROOM_CHANGED',
    roomId: signal.roomId,
    roomCode: signal.roomCode,
    roomVersion: signal.roomVersion,
    tableStateVersion: signal.tableStateVersion
  })
}

export function parseOnlineRoomChangedSignal(payload: string): OnlineRoomChangedSignal | null {
  try {
    const parsed = signalSchema.safeParse(JSON.parse(payload))
    if (!parsed.success) return null
    const signal = parsed.data
    assertSignal(signal)
    return signal
  } catch {
    return null
  }
}

/** A small Redis Pub/Sub wrapper. It never carries raw internal room state. */
export class OnlineRoomRealtimeBus {
  private readonly publisher: Redis
  private readonly subscriber: Redis
  private readonly channel: string
  private readonly ownsPublisher: boolean
  private readonly ownsSubscriber: boolean
  private readonly listeners = new Set<SignalListener>()
  private subscribePromise: Promise<void> | undefined
  private subscriberState: OnlineRoomRealtimeSubscriberState = 'DISCONNECTED'
  private subscriberReconnectAttempt = 0
  private subscriberReconnectTimer: ReturnType<typeof setTimeout> | undefined
  private subscriberGeneration = 0
  private subscriberAttemptInFlight = false
  private stopped = false
  private subscribed = false

  constructor(options: Readonly<{ redisUrl?: string; publisher?: Redis; subscriber?: Redis; channel?: string }> = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL
    if (!options.publisher && !options.subscriber && !redisUrl) throw new Error('REDIS_URL is required for online room realtime.')
    this.channel = options.channel ?? ONLINE_ROOM_REALTIME_CHANNEL
    this.publisher = options.publisher ?? new Redis(redisUrl!, redisOptions())
    this.subscriber = options.subscriber ?? new Redis(redisUrl!, redisOptions())
    this.ownsPublisher = !options.publisher
    this.ownsSubscriber = !options.subscriber
    this.publisher.on('error', () => {})
    this.subscriber.on('error', () => this.handleSubscriberDisconnected())
    this.subscriber.on('close', () => this.handleSubscriberDisconnected())
    this.subscriber.on('end', () => this.handleSubscriberDisconnected())
    this.subscriber.on('message', (_channel, payload) => {
      const signal = parseOnlineRoomChangedSignal(payload)
      if (!signal) return
      for (const listener of this.listeners) {
        Promise.resolve(listener(signal)).catch(() => undefined)
      }
    })
  }

  private async connect(client: Redis): Promise<void> {
    if (client.status === 'connecting' || client.status === 'connect' || client.status === 'reconnecting') {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          cleanup()
          resolve()
        }
        const ended = () => {
          cleanup()
          reject(new Error('Redis connection ended before it became ready.'))
        }
        const errored = (error: Error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          client.off('ready', ready)
          client.off('end', ended)
          client.off('error', errored)
        }
        client.once('ready', ready)
        client.once('end', ended)
        client.once('error', errored)
      })
    } else if (client.status === 'close') {
      await client.connect()
    } else if (client.status === 'wait' || client.status === 'end') {
      await client.connect()
    }
    if (client.status !== 'ready') throw new Error('Redis is not ready.')
  }

  private reconnectDelay(): number {
    if (this.subscriberReconnectAttempt <= 0) return 0
    return Math.min(
      ONLINE_ROOM_REALTIME_RECONNECT_MAX_MS,
      ONLINE_ROOM_REALTIME_RECONNECT_BASE_MS * (2 ** Math.min(this.subscriberReconnectAttempt - 1, 6))
    )
  }

  private scheduleSubscriberReconnect(): void {
    if (this.stopped || this.listeners.size === 0 || this.subscriberReconnectTimer || this.subscribePromise || this.subscriberAttemptInFlight) return
    const delay = this.reconnectDelay()
    this.subscriberReconnectTimer = setTimeout(() => {
      this.subscriberReconnectTimer = undefined
      void this.ensureSubscriber().catch(() => undefined)
    }, delay)
    this.subscriberReconnectTimer.unref?.()
  }

  private handleSubscriberDisconnected(): void {
    const wasConnecting = this.subscriberAttemptInFlight
    this.subscriberGeneration += 1
    this.subscribed = false
    if (!wasConnecting) this.subscribePromise = undefined
    this.subscriberState = this.stopped ? 'STOPPED' : 'DISCONNECTED'
    if (!wasConnecting) this.scheduleSubscriberReconnect()
  }

  private async connectSubscriber(): Promise<void> {
    if (this.stopped) throw new Error('Online room realtime bus is stopped.')
    const generation = this.subscriberGeneration
    this.subscriberState = 'CONNECTING'
    await this.connect(this.subscriber)
    if (this.stopped || generation !== this.subscriberGeneration) throw new Error('Subscriber connection became stale.')
    this.subscriberState = 'SUBSCRIBING'
    await this.subscriber.subscribe(this.channel)
    if (this.stopped || generation !== this.subscriberGeneration) throw new Error('Subscriber subscription became stale.')
    this.subscribed = true
    this.subscriberState = 'READY'
    this.subscriberReconnectAttempt = 0
  }

  private ensureSubscriber(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Online room realtime bus is stopped.'))
    if (this.subscriberState === 'READY' && this.subscribed) return Promise.resolve()
    if (!this.subscribePromise) {
      this.subscriberAttemptInFlight = true
      this.subscribePromise = this.connectSubscriber()
        .finally(() => {
          this.subscriberAttemptInFlight = false
        })
        .catch(error => {
          this.subscribePromise = undefined
          this.subscribed = false
          if (!this.stopped) {
            this.subscriberState = 'DISCONNECTED'
            this.subscriberReconnectAttempt += 1
            this.scheduleSubscriberReconnect()
          }
          throw error
        })
    }
    return this.subscribePromise
  }

  async publish(signal: OnlineRoomChangedSignal): Promise<void> {
    const payload = serializeOnlineRoomChangedSignal(signal)
    await this.connect(this.publisher)
    await this.publisher.publish(this.channel, payload)
  }

  async subscribe(listener: SignalListener): Promise<() => void> {
    if (this.stopped) throw new Error('Online room realtime bus is stopped.')
    this.listeners.add(listener)
    try {
      await this.ensureSubscriber()
    } catch (error) {
      // Keep the listener registered while the background reconnect state
      // machine retries. Existing sockets must recover without resubmitting.
      throw error
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSubscriberState(): OnlineRoomRealtimeSubscriberState {
    return this.subscriberState
  }

  isSubscriberSubscribed(): boolean {
    return this.subscribed
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.subscriberState = 'STOPPED'
    this.subscribed = false
    this.subscribePromise = undefined
    if (this.subscriberReconnectTimer) {
      clearTimeout(this.subscriberReconnectTimer)
      this.subscriberReconnectTimer = undefined
    }
    if (this.ownsPublisher) this.publisher.disconnect()
    if (this.ownsSubscriber) this.subscriber.disconnect()
  }
}

let defaultBus: OnlineRoomRealtimeBus | undefined

export function getOnlineRoomRealtimeBus(): OnlineRoomRealtimeBus {
  return (defaultBus ??= new OnlineRoomRealtimeBus())
}

export async function publishOnlineRoomChanged(signal: OnlineRoomChangedSignal): Promise<void> {
  return getOnlineRoomRealtimeBus().publish(signal)
}
