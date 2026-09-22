import { randomUUID } from 'node:crypto'
import type { PersistentBotIdentity } from './botIdentityService'
import { decideBotAction, secureBotRandom } from '../utils/pokerBotDecision'
import type { BotDecisionContext } from '../utils/pokerBotDecision'
import type { BettingActionType } from '../utils/pokerBetting'
import type { ApiOnlineRoomResult, OnlineRoomLobbyEntry, OnlineRoomApiDependencies } from './onlineRoomApiService'
import type { OnlinePokerBotLease, OnlinePokerBotLeaseService } from './onlinePokerBotLeaseService'

export type OnlinePokerBotOrchestratorConfig = Readonly<{
  enabled: boolean
  minActiveBots: number
  maxActiveBots: number
  maxBotsPerRoom: number
  maxBotCreatedRooms: number
  tickIntervalMs: number
  activityWindowMs?: number
  startingStack: number
  smallBlind: number
  bigBlind: number
  quickJoinProbability: number
  createRoomProbability: number
}>

export function readOnlinePokerBotOrchestratorConfig(env: NodeJS.ProcessEnv = process.env): OnlinePokerBotOrchestratorConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]
    if (!raw) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
  }
  const probability = (key: string, fallback: number) => {
    const value = Number(env[key])
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
  }
  const smallBlind = integer('BOT_ORCHESTRATOR_SMALL_BLIND', 5, 1, 1_000_000)
  const configuredBigBlind = integer('BOT_ORCHESTRATOR_BIG_BLIND', 10, 1, 2_000_000)
  const bigBlind = configuredBigBlind >= smallBlind ? configuredBigBlind : Math.max(10, smallBlind * 2)
  const maxActiveBots = integer('BOT_ORCHESTRATOR_MAX_ACTIVE_BOTS', 6, 1, 12)
  const minActiveBots = Math.min(maxActiveBots, integer('BOT_ORCHESTRATOR_MIN_ACTIVE_BOTS', 2, 1, 12))
  return Object.freeze({
    enabled: env.BOT_ORCHESTRATOR_ENABLED === 'true',
    minActiveBots,
    maxActiveBots,
    maxBotsPerRoom: integer('BOT_ORCHESTRATOR_MAX_BOTS_PER_ROOM', 3, 1, 6),
    maxBotCreatedRooms: integer('BOT_ORCHESTRATOR_MAX_CREATED_ROOMS', 1, 0, 6),
    tickIntervalMs: integer('BOT_ORCHESTRATOR_TICK_MS', 1_000, 250, 30_000),
    activityWindowMs: integer('BOT_ORCHESTRATOR_ACTIVITY_WINDOW_MS', 5 * 60_000, 60_000, 24 * 60 * 60_000),
    startingStack: integer('BOT_ORCHESTRATOR_STARTING_STACK', 1_000, 1, 2_000_000_000),
    smallBlind,
    bigBlind,
    quickJoinProbability: probability('BOT_ORCHESTRATOR_QUICK_JOIN_CHANCE', 0.02),
    createRoomProbability: probability('BOT_ORCHESTRATOR_CREATE_CHANCE', 0.01)
  })
}

export type BotRoomSnapshot = ApiOnlineRoomResult['room']
export type BotActionDecisionSnapshot = Readonly<{
  room: BotRoomSnapshot
  legalActions: readonly BettingActionType[]
  toCall: number
  minRaiseTo: number
  raiseReopened: boolean
}>

export type OnlinePokerBotOrchestratorAdapter = Readonly<{
  listBots(): Promise<readonly PersistentBotIdentity[]>
  listPublicRooms(): Promise<readonly OnlineRoomLobbyEntry[]>
  countBotCreatedRooms(botIds: readonly string[]): Promise<number>
  cleanupBotCreatedRooms(botIds: readonly string[], olderThan: Date): Promise<number>
  findSeatedRoom(userId: string): Promise<string | null>
  getRoom(userId: string, code: string, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
  getDecisionSnapshot(userId: string, code: string, dependencies: OnlineRoomApiDependencies): Promise<BotActionDecisionSnapshot>
  createRoom(userId: string, input: Readonly<{ visibility: 'PUBLIC'; startingStack: number; smallBlind: number; bigBlind: number }>, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
  joinRoom(userId: string, code: string, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
  ready(userId: string, code: string, ready: boolean, room: BotRoomSnapshot, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
  startHand(userId: string, code: string, expectedStateVersion: number, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
  action(userId: string, code: string, input: Readonly<{ actionId: string; expectedTableStateVersion: number; action: Readonly<{ type: BettingActionType; amount?: number }> }>, dependencies: OnlineRoomApiDependencies): Promise<unknown>
  leave(userId: string, code: string, room: BotRoomSnapshot, dependencies: OnlineRoomApiDependencies): Promise<ApiOnlineRoomResult>
}>

export type OnlinePokerBotOrchestratorDependencies = Readonly<{
  config: OnlinePokerBotOrchestratorConfig
  lease: Pick<OnlinePokerBotLeaseService, 'acquire' | 'renew' | 'release'>
  adapter: OnlinePokerBotOrchestratorAdapter
  now?: () => number
  random?: () => number
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void
}>

type PendingWork = { key: string; dueAt: number; actionId?: string; decision?: ReturnType<typeof decideBotAction> }

/** Coordinates bots; poker decisions and mutations stay in their existing authoritative services. */
export class OnlinePokerBotOrchestrator {
  private readonly now: () => number
  private readonly random: () => number
  private readonly pending = new Map<string, PendingWork>()
  private readonly leases = new Map<string, OnlinePokerBotLease>()
  private activeBotIds = new Set<string>()
  private schedulerLease: OnlinePokerBotLease | undefined
  private createdRoomReservations = 0
  private running = false

  constructor(private readonly dependencies: OnlinePokerBotOrchestratorDependencies) {
    this.now = dependencies.now ?? Date.now
    this.random = dependencies.random ?? (() => (secureBotRandom as { next: () => number }).next())
  }

  async tick(): Promise<void> {
    const { config, adapter } = this.dependencies
    if (!config.enabled || this.running) return
    this.running = true
    try {
      if (this.schedulerLease && !await this.dependencies.lease.renew(this.schedulerLease).catch(() => false)) this.schedulerLease = undefined
      this.schedulerLease ??= await this.dependencies.lease.acquire('__scheduler__').catch(() => null) ?? undefined
      if (!this.schedulerLease) return
      this.createdRoomReservations = 0
      const bots = await adapter.listBots()
      const botIds = new Set(bots.map(bot => bot.id))
      const closedRooms = await adapter.cleanupBotCreatedRooms([...botIds], new Date(this.now() - 30 * 60_000)).catch(() => 0)
      if (closedRooms > 0) this.dependencies.log?.('bot_empty_rooms_closed', { count: closedRooms })
      const rooms = await adapter.listPublicRooms()
      const orderedBots = [...bots].sort((a, b) => a.botKey.localeCompare(b.botKey))
      const activeRange = Math.max(1, Math.min(config.maxActiveBots, orderedBots.length) - Math.min(config.minActiveBots, orderedBots.length) + 1)
      const activityWindow = Math.floor(this.now() / (config.activityWindowMs ?? 5 * 60_000))
      const activeCount = Math.min(orderedBots.length, config.minActiveBots + (activityWindow % activeRange))
      const offset = orderedBots.length ? (activityWindow * 7) % orderedBots.length : 0
      const rotated = orderedBots.slice(offset).concat(orderedBots.slice(0, offset))
      const activeIds = new Set(rotated.slice(0, activeCount).map(bot => bot.id))
      for (const bot of bots) {
        if (activeIds.has(bot.id) && bot.botEnabled && !this.activeBotIds.has(bot.id)) this.dependencies.log?.('bot_activated', { botKey: bot.botKey })
      }
      this.activeBotIds = activeIds
      await Promise.all(bots.map(async bot => {
        let lease = this.leases.get(bot.botKey)
        if (lease && !await this.dependencies.lease.renew(lease).catch(() => false)) {
          this.dependencies.log?.('bot_lease_lost', { botKey: bot.botKey })
          this.leases.delete(bot.botKey)
          lease = undefined
        }
        if (!bot.botEnabled) {
          if (lease) await this.dependencies.lease.release(lease).catch(() => false)
          this.leases.delete(bot.botKey)
          return
        }
        lease ??= await this.dependencies.lease.acquire(bot.botKey).catch(() => null) ?? undefined
        if (!lease) return
        this.leases.set(bot.botKey, lease)
        try {
          const fence: OnlineRoomApiDependencies = { botFence: { key: lease.leaseKey, token: lease.token } }
          const roomCode = await adapter.findSeatedRoom(bot.id).catch(() => null)
          if (roomCode) {
            await this.progressSeatedBot(bot, roomCode, fence, activeIds.has(bot.id), botIds)
            return
          }
          this.pending.delete(bot.id)
          if (!activeIds.has(bot.id) || bot.balance < config.startingStack) return
          await this.findRoomOrCreate(bot, rooms, botIds, fence)
        } catch (error) {
          this.dependencies.log?.('bot_orchestrator_operation_rejected', { botKey: bot.botKey, code: errorCode(error) })
        }
      }))
    } finally { this.running = false }
  }

  async shutdown(): Promise<void> {
    const current = [...this.leases.values()]
    this.leases.clear()
    await Promise.all(current.map(lease => this.dependencies.lease.release(lease).catch(() => false)))
    if (this.schedulerLease) await this.dependencies.lease.release(this.schedulerLease).catch(() => false)
    this.schedulerLease = undefined
  }

  private async findRoomOrCreate(bot: PersistentBotIdentity, rooms: readonly OnlineRoomLobbyEntry[], botIds: ReadonlySet<string>, fence: OnlineRoomApiDependencies): Promise<void> {
    const { config, adapter } = this.dependencies
    const candidates = [...rooms].filter(room => room.playerCount < room.maxPlayers).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const candidate of candidates) {
      if (candidate.startingStack > bot.balance) continue
      if (this.now() - Date.parse(candidate.createdAt) < 8_000 && this.random() >= config.quickJoinProbability) continue
      const publicRoom = await adapter.getRoom(bot.id, candidate.code, fence).catch(() => null)
      if (!publicRoom || publicRoom.room.visibility !== 'PUBLIC') continue
      const table = publicRoom.room.pokerTable
      const botCount = table.players.filter(player => botIds.has(player.playerId)).length
      const botOwnedRoom = table.players.some(player => player.playerId === publicRoom.room.ownerId && botIds.has(player.playerId))
      const humanPresent = table.players.some(player => !botIds.has(player.playerId))
      const roomLimit = botOwnedRoom && !humanPresent ? 6 : config.maxBotsPerRoom
      if (botCount >= roomLimit) continue
      if (table.players.some(player => player.playerId === bot.id)) return
      await adapter.joinRoom(bot.id, candidate.code, fence)
      this.dependencies.log?.('bot_joined_public_room', { botKey: bot.botKey, roomCode: candidate.code })
      return
    }

    const activeBotRooms = await adapter.countBotCreatedRooms([...botIds])
    const otherFundedBots = (await adapter.listBots()).filter(item => item.botEnabled && item.balance >= config.startingStack).length
    if (config.maxBotCreatedRooms > 0 && activeBotRooms + this.createdRoomReservations < config.maxBotCreatedRooms && otherFundedBots >= 2 && this.random() < config.createRoomProbability) {
      this.createdRoomReservations += 1
      try {
        const created = await adapter.createRoom(bot.id, { visibility: 'PUBLIC', startingStack: config.startingStack, smallBlind: config.smallBlind, bigBlind: config.bigBlind }, fence)
        this.dependencies.log?.('bot_created_public_room', { botKey: bot.botKey, roomCode: created.room.roomCode })
      } catch (error) {
        this.createdRoomReservations -= 1
        throw error
      }
    }
  }

  private async progressSeatedBot(bot: PersistentBotIdentity, code: string, fence: OnlineRoomApiDependencies, active: boolean, botIds: ReadonlySet<string>): Promise<void> {
    const { adapter, config } = this.dependencies
    const result = await adapter.getRoom(bot.id, code, fence)
    const room = result.room
    if (room.visibility !== 'PUBLIC') {
      this.dependencies.log?.('bot_private_room_rejected', { botKey: bot.botKey })
      return
    }
    const table = room.pokerTable
    const seated = table.players.find(player => player.playerId === bot.id)
    if (!seated) { this.pending.delete(bot.id); return }
    const handInProgress = table.currentHand !== null && table.currentHand.street !== 'FINISHED'
    if ((!active || seated.stack <= 0) && !handInProgress) {
      await adapter.leave(bot.id, code, room, fence)
      this.pending.delete(bot.id)
      this.dependencies.log?.('bot_left_room', { botKey: bot.botKey, roomCode: code })
      return
    }
    if (table.currentHand && table.currentHand.street !== 'FINISHED') {
      if (table.currentHand.currentActor !== seated.seat) return
      const snapshot = await adapter.getDecisionSnapshot(bot.id, code, fence)
      const hand = snapshot.room.pokerTable.currentHand
      const own = hand?.players.find(player => player.playerId === bot.id)
      if (!hand || !own || own.holeCards.length !== 2 || hand.street === 'SHOWDOWN' || hand.street === 'FINISHED') return
      const key = `${hand.handId}:${table.stateVersion}`
      const context: BotDecisionContext = {
        playerId: bot.id,
        street: hand.street,
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
        activePlayers: hand.players.filter(player => player.status === 'ACTIVE' || player.status === 'ALL_IN').length,
        publicPlayers: hand.players.map(player => ({ playerId: player.playerId, seat: player.seat, stack: player.stack, streetContribution: player.streetContribution, status: player.status })),
        minRaiseTo: snapshot.minRaiseTo,
        raiseReopened: snapshot.raiseReopened,
        legalActions: snapshot.legalActions
      }
      let work = this.pending.get(bot.id)
      if (!work || work.key !== key) {
        const decision = decideBotAction(context, { skillTier: bot.skillTier, playStyle: bot.playStyle }, this.random)
        work = this.scheduled(bot.id, key, this.actionDelay(decision.type))
        work.decision = decision
        this.pending.set(bot.id, work)
      }
      if (this.now() < work.dueAt) return
      const decision = work.decision!
      work.actionId ??= randomUUID()
      try {
        await adapter.action(bot.id, code, {
          actionId: work.actionId,
          expectedTableStateVersion: table.stateVersion,
          action: { type: decision.type, ...(decision.amount === undefined ? {} : { amount: decision.amount }) }
        }, fence)
      } catch (error) {
        this.dependencies.log?.('bot_action_rejected', { botKey: bot.botKey, code: errorCode(error) })
        throw error
      }
      this.pending.delete(bot.id)
      return
    }

    if (!active || !seated.ready) {
      if (!active) return
      const key = `ready:${table.stateVersion}`
      const work = this.scheduled(bot.id, key, 1_000 + this.random() * 3_000)
      if (this.now() < work.dueAt) return
      await adapter.ready(bot.id, code, true, room, fence)
      this.pending.delete(bot.id)
      return
    }
    const readyPlayers = table.players.filter(player => player.ready && !player.sittingOut && player.stack > 0)
    const ownsRoom = room.ownerId === bot.id
    if (ownsRoom && readyPlayers.length >= 2 && (!table.currentHand || table.currentHand.street === 'FINISHED')) {
      const key = `start:${table.stateVersion}`
      const work = this.scheduled(bot.id, key, 1_500 + this.random() * 4_500)
      if (this.now() < work.dueAt) return
      await adapter.startHand(bot.id, code, table.stateVersion, fence)
      this.pending.delete(bot.id)
    }
    void botIds
  }

  private scheduled(botId: string, key: string, delayMs: number): PendingWork {
    const existing = this.pending.get(botId)
    if (existing?.key === key) return existing
    const pending = { key, dueAt: this.now() + delayMs }
    this.pending.set(botId, pending)
    return pending
  }

  private actionDelay(action: BettingActionType): number {
    if (action === 'check' || action === 'fold') return 700 + this.random() * 1_300
    if (action === 'call') return 1_500 + this.random() * 3_500
    return 3_000 + this.random() * 5_000
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'OPERATION_FAILED'
}

export function botLeaseDependencies(lease: OnlinePokerBotLease): OnlineRoomApiDependencies {
  return Object.freeze({ botFence: Object.freeze({ key: lease.leaseKey, token: lease.token }) })
}
