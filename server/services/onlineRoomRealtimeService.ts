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
  private readonly ownsClients: boolean
  private readonly listeners = new Set<SignalListener>()
  private subscribePromise: Promise<void> | undefined

  constructor(options: Readonly<{ redisUrl?: string; publisher?: Redis; subscriber?: Redis; channel?: string }> = {}) {
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL
    if (!options.publisher && !options.subscriber && !redisUrl) throw new Error('REDIS_URL is required for online room realtime.')
    this.channel = options.channel ?? ONLINE_ROOM_REALTIME_CHANNEL
    this.publisher = options.publisher ?? new Redis(redisUrl!, redisOptions())
    this.subscriber = options.subscriber ?? new Redis(redisUrl!, redisOptions())
    this.ownsClients = !options.publisher && !options.subscriber
    this.publisher.on('error', () => {})
    this.subscriber.on('error', () => {})
    this.subscriber.on('message', (_channel, payload) => {
      const signal = parseOnlineRoomChangedSignal(payload)
      if (!signal) return
      for (const listener of this.listeners) {
        Promise.resolve(listener(signal)).catch(() => undefined)
      }
    })
  }

  private async connect(client: Redis): Promise<void> {
    if (client.status === 'wait' || client.status === 'end') await client.connect()
    if (client.status !== 'ready') throw new Error('Redis is not ready.')
  }

  async publish(signal: OnlineRoomChangedSignal): Promise<void> {
    const payload = serializeOnlineRoomChangedSignal(signal)
    await this.connect(this.publisher)
    await this.publisher.publish(this.channel, payload)
  }

  async subscribe(listener: SignalListener): Promise<() => void> {
    this.listeners.add(listener)
    this.subscribePromise ??= this.connect(this.subscriber).then(() => this.subscriber.subscribe(this.channel)).then(() => undefined).catch(error => {
      this.subscribePromise = undefined
      this.listeners.delete(listener)
      throw error
    })
    try {
      await this.subscribePromise
    } catch (error) {
      throw error
    }
    return () => this.listeners.delete(listener)
  }

  async disconnect(): Promise<void> {
    if (!this.ownsClients) return
    this.publisher.disconnect()
    this.subscriber.disconnect()
  }
}

let defaultBus: OnlineRoomRealtimeBus | undefined

export function getOnlineRoomRealtimeBus(): OnlineRoomRealtimeBus {
  return (defaultBus ??= new OnlineRoomRealtimeBus())
}

export async function publishOnlineRoomChanged(signal: OnlineRoomChangedSignal): Promise<void> {
  return getOnlineRoomRealtimeBus().publish(signal)
}
