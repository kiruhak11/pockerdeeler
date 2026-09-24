import { randomUUID } from 'node:crypto'
import type { PersistentBotIdentity } from './botIdentityService'
import { decideBotAction, secureBotRandom } from '../utils/pokerBotDecision'
import type { BotDecisionContext } from '../utils/pokerBotDecision'
import type { BettingActionType } from '../utils/pokerBetting'
import type { ApiOnlineRoomResult, OnlineRoomLobbyEntry, OnlineRoomApiDependencies } from './onlineRoomApiService'
import type { OnlinePokerBotLease, OnlinePokerBotLeaseService } from './onlinePokerBotLeaseService'
import type { BotRocketFence, BotRocketSnapshot } from './crashService'

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
  rocketPlayProbability?: number
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
    createRoomProbability: probability('BOT_ORCHESTRATOR_CREATE_CHANCE', 0.01),
    rocketPlayProbability: probability('BOT_ORCHESTRATOR_ROCKET_CHANCE', 0.15)
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
  registerRocketLease?(userId: string, fence: BotRocketFence): Promise<void>
  getRocketSnapshot?(botIds: readonly string[], assertSchedulerLease: () => Promise<boolean>): Promise<BotRocketSnapshot>
  placeRocketBet?(userId: string, input: Readonly<{ expectedRoundId: string; stake: number; autoCashout: number | null }>, fence: BotRocketFence): Promise<boolean>
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
type PendingRocketBet = Readonly<{
  roundId: string
  dueAt: number
  shouldPlay: boolean
  stake: number
  autoCashout: number
}>

/** Coordinates bots; poker decisions and mutations stay in their existing authoritative services. */
export class OnlinePokerBotOrchestrator {
  private readonly now: () => number
  private readonly random: () => number
  private readonly pending = new Map<string, PendingWork>()
  private readonly pendingRocketBets = new Map<string, PendingRocketBet>()
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
      let rocketSnapshot: BotRocketSnapshot | undefined
      if (adapter.getRocketSnapshot && adapter.placeRocketBet) {
        const schedulerLease = this.schedulerLease
        rocketSnapshot = await adapter.getRocketSnapshot(bots.filter(bot => bot.botEnabled).map(bot => bot.id), async () => {
          return schedulerLease ? this.dependencies.lease.renew(schedulerLease).catch(() => false) : false
        }).catch(error => {
          this.dependencies.log?.('bot_rocket_snapshot_failed', { code: errorCode(error) })
          return undefined
        })
      }
      await Promise.all(bots.map(async bot => {
        let lease = this.leases.get(bot.botKey)
        if (lease && !await this.dependencies.lease.renew(lease).catch(() => false)) {
          this.dependencies.log?.('bot_lease_lost', { botKey: bot.botKey })
          this.leases.delete(bot.botKey)
          lease = undefined
        }
        let acquiredLease = false
        if (!bot.botEnabled) {
          if (lease) await this.dependencies.lease.release(lease).catch(() => false)
          this.leases.delete(bot.botKey)
          this.pendingRocketBets.delete(bot.id)
          return
        }
        if (!lease) {
          lease = await this.dependencies.lease.acquire(bot.botKey).catch(() => null) ?? undefined
          acquiredLease = Boolean(lease)
        }
        if (!lease) return
        const rocketFence = this.rocketFence(lease)
        if (acquiredLease && adapter.registerRocketLease) {
          try {
            await adapter.registerRocketLease(bot.id, rocketFence)
          } catch (error) {
            await this.dependencies.lease.release(lease).catch(() => false)
            this.pendingRocketBets.delete(bot.id)
            this.dependencies.log?.('bot_rocket_lease_registration_rejected', { botKey: bot.botKey, code: errorCode(error) })
            return
          }
        }
        this.leases.set(bot.botKey, lease)
        try {
          const fence: OnlineRoomApiDependencies = { botFence: { key: lease.leaseKey, token: lease.token } }
          const roomCode = await adapter.findSeatedRoom(bot.id).catch(() => null)
          if (roomCode) {
            this.pendingRocketBets.delete(bot.id)
            await this.progressSeatedBot(bot, roomCode, fence, activeIds.has(bot.id), botIds)
            return
          }
          this.pending.delete(bot.id)
          if (!activeIds.has(bot.id)) {
            this.pendingRocketBets.delete(bot.id)
            return
          }
          if (bot.balance >= config.startingStack) {
            const pokerPriority = await this.findRoomOrCreate(bot, rooms, botIds, fence)
            if (pokerPriority) {
              this.pendingRocketBets.delete(bot.id)
              return
            }
          }
          const rocketState = rocketSnapshot?.bots[bot.id]
          if (rocketSnapshot && rocketState && adapter.placeRocketBet) {
            await this.progressRocketBot(bot, rocketSnapshot, rocketState, rocketFence)
          } else this.pendingRocketBets.delete(bot.id)
        } catch (error) {
          this.dependencies.log?.('bot_orchestrator_operation_rejected', { botKey: bot.botKey, code: errorCode(error) })
        }
      }))
    } finally { this.running = false }
  }

  async shutdown(): Promise<void> {
    const current = [...this.leases.values()]
    this.leases.clear()
    this.pendingRocketBets.clear()
    await Promise.all(current.map(lease => this.dependencies.lease.release(lease).catch(() => false)))
    if (this.schedulerLease) await this.dependencies.lease.release(this.schedulerLease).catch(() => false)
    this.schedulerLease = undefined
  }

  /**
   * Room CAS conflicts are expected when multiple bots (or a human) mutate the
   * same room. Re-read once, treat an already-achieved goal as success, and
   * retry at most once while the same lease token still owns the bot.
   */
  private async mutateWithConflictRecovery(
    bot: PersistentBotIdentity,
    code: string,
    fence: OnlineRoomApiDependencies,
    room: BotRoomSnapshot,
    operation: string,
    execute: (current: BotRoomSnapshot, retry?: boolean) => Promise<unknown>,
    stillNeeded: (current: BotRoomSnapshot) => boolean
  ): Promise<boolean> {
    try {
      await execute(room)
      return true
    } catch (error) {
      if (!isConcurrencyConflict(error)) throw error
      this.dependencies.log?.('bot_orchestrator_conflict', { botKey: bot.botKey, operation, code: errorCode(error) })
    }

    if (!await this.renewCurrentLease(bot, fence)) return false
    const refreshed = await this.dependencies.adapter.getRoom(bot.id, code, fence)
    if (!stillNeeded(refreshed.room)) {
      this.dependencies.log?.('bot_orchestrator_conflict_resolved', { botKey: bot.botKey, operation, outcome: 'goal_already_met' })
      return true
    }
    if (!await this.renewCurrentLease(bot, fence)) return false

    try {
      await execute(refreshed.room, true)
      return true
    } catch (error) {
      if (!isConcurrencyConflict(error)) throw error
      this.dependencies.log?.('bot_orchestrator_conflict', { botKey: bot.botKey, operation, code: errorCode(error), retry: 1 })
      if (!await this.renewCurrentLease(bot, fence)) return false
      const latest = await this.dependencies.adapter.getRoom(bot.id, code, fence)
      if (!stillNeeded(latest.room)) {
        this.dependencies.log?.('bot_orchestrator_conflict_resolved', { botKey: bot.botKey, operation, outcome: 'goal_already_met_after_retry' })
        return true
      }
      this.dependencies.log?.('bot_orchestrator_conflict_deferred', { botKey: bot.botKey, operation })
      return false
    }
    return true
  }

  private async renewCurrentLease(bot: PersistentBotIdentity, fence: OnlineRoomApiDependencies): Promise<boolean> {
    const lease = this.leases.get(bot.botKey)
    const expectedFence = fence.botFence
    if (!lease || !expectedFence || lease.token !== expectedFence.token || lease.leaseKey !== expectedFence.key) {
      this.leases.delete(bot.botKey)
      this.dependencies.log?.('bot_lease_lost', { botKey: bot.botKey })
      return false
    }
    const renewed = await this.dependencies.lease.renew(lease).catch(() => false)
    if (!renewed) {
      this.leases.delete(bot.botKey)
      this.pending.delete(bot.id)
      this.dependencies.log?.('bot_lease_lost', { botKey: bot.botKey })
    }
    return renewed
  }

  private async findRoomOrCreate(bot: PersistentBotIdentity, rooms: readonly OnlineRoomLobbyEntry[], botIds: ReadonlySet<string>, fence: OnlineRoomApiDependencies): Promise<boolean> {
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
      if (table.players.some(player => player.playerId === bot.id)) return true
      await this.mutateWithConflictRecovery(bot, candidate.code, fence, publicRoom.room, 'join',
        current => adapter.joinRoom(bot.id, candidate.code, fence),
        current => current.visibility === 'PUBLIC'
          && current.pokerTable.players.length < current.maxPlayers
          && !current.pokerTable.players.some(player => player.playerId === bot.id)
          && bot.balance >= candidate.startingStack)
      if (await adapter.findSeatedRoom(bot.id).catch(() => null) === candidate.code) {
        this.dependencies.log?.('bot_joined_public_room', { botKey: bot.botKey, roomCode: candidate.code })
      }
      return true
    }

    const activeBotRooms = await adapter.countBotCreatedRooms([...botIds])
    const otherFundedBots = (await adapter.listBots()).filter(item => item.botEnabled && item.balance >= config.startingStack).length
    if (config.maxBotCreatedRooms > 0 && activeBotRooms + this.createdRoomReservations < config.maxBotCreatedRooms && otherFundedBots >= 2 && this.random() < config.createRoomProbability) {
      this.createdRoomReservations += 1
      try {
        const created = await adapter.createRoom(bot.id, { visibility: 'PUBLIC', startingStack: config.startingStack, smallBlind: config.smallBlind, bigBlind: config.bigBlind }, fence)
        this.dependencies.log?.('bot_created_public_room', { botKey: bot.botKey, roomCode: created.room.roomCode })
        return true
      } catch (error) {
        this.createdRoomReservations -= 1
        throw error
      }
    }
    return false
  }

  private rocketFence(lease: OnlinePokerBotLease): BotRocketFence {
    return Object.freeze({
      key: lease.leaseKey,
      token: lease.token,
      isLeaseCurrent: () => this.dependencies.lease.renew(lease).catch(() => false)
    })
  }

  private async progressRocketBot(
    bot: PersistentBotIdentity,
    snapshot: BotRocketSnapshot,
    state: Readonly<{ balance: number; hasBet: boolean }>,
    fence: BotRocketFence
  ): Promise<void> {
    const { adapter, config } = this.dependencies
    const placeRocketBet = adapter.placeRocketBet
    if (!placeRocketBet) return
    if (snapshot.phase !== 'betting' || state.hasBet || state.balance < 1 || snapshot.bettingMsRemaining < 100) {
      this.pendingRocketBets.delete(bot.id)
      return
    }

    let plan = this.pendingRocketBets.get(bot.id)
    if (!plan || plan.roundId !== snapshot.roundId) {
      const shouldPlay = this.random() < (config.rocketPlayProbability ?? 0)
      const delayMs = 700 + this.random() * 4_300
      const remaining = snapshot.bettingMsRemaining
      const dueAt = this.now() + Math.min(delayMs, Math.max(100, remaining - 100))
      const portion = 0.005 + this.random() * 0.015
      const stake = Math.min(1_000_000, Math.max(1, Math.floor(state.balance * portion)))
      const autoCashout = Math.floor((1.05 + this.random() * 1.95) * 100) / 100
      plan = Object.freeze({ roundId: snapshot.roundId, dueAt, shouldPlay, stake, autoCashout })
      this.pendingRocketBets.set(bot.id, plan)
    }
    if (!plan.shouldPlay || this.now() < plan.dueAt) return

    const placed = await placeRocketBet(bot.id, {
      expectedRoundId: plan.roundId,
      stake: Math.min(plan.stake, state.balance),
      autoCashout: plan.autoCashout
    }, fence)
    this.pendingRocketBets.delete(bot.id)
    if (placed) this.dependencies.log?.('bot_rocket_bet_placed', { botKey: bot.botKey, stake: Math.min(plan.stake, state.balance) })
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
      const left = await this.mutateWithConflictRecovery(bot, code, fence, room, 'leave',
        current => adapter.leave(bot.id, code, current, fence),
        current => !current.pokerTable.currentHand || current.pokerTable.currentHand.street === 'FINISHED'
          ? current.pokerTable.players.some(player => player.playerId === bot.id)
          : false)
      if (!left) return
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
      const acted = await this.mutateWithConflictRecovery(bot, code, fence, room, 'action',
        async (current, retry) => {
          let latestRoom = current
          if (retry) {
            const fresh = await adapter.getDecisionSnapshot(bot.id, code, fence)
            latestRoom = fresh.room
            const freshHand = latestRoom.pokerTable.currentHand
            const freshOwn = freshHand?.players.find(player => player.playerId === bot.id)
            if (!freshHand || freshHand.handId !== hand.handId || freshHand.currentActor !== seated.seat || !freshOwn
              || !fresh.legalActions.includes(decision.type)) return
            if (decision.type === 'raise' && (decision.amount === undefined || decision.amount < fresh.minRaiseTo
              || decision.amount > freshOwn.streetContribution + freshOwn.stack)) return
            if (decision.type === 'bet' && (decision.amount === undefined
              || decision.amount > freshOwn.streetContribution + freshOwn.stack
              || (decision.amount < freshHand.bigBlind && decision.amount !== freshOwn.streetContribution + freshOwn.stack))) return
          }
          const latestHand = latestRoom.pokerTable.currentHand
          if (!latestHand || latestHand.handId !== hand.handId || latestHand.currentActor !== seated.seat) return
          return adapter.action(bot.id, code, {
            actionId: work.actionId!,
            expectedTableStateVersion: latestRoom.pokerTable.stateVersion,
            action: { type: decision.type, ...(decision.amount === undefined ? {} : { amount: decision.amount }) }
          }, fence)
        },
        current => {
          const latestHand = current.pokerTable.currentHand
          return Boolean(latestHand && latestHand.handId === hand.handId && latestHand.currentActor === seated.seat
            && latestHand.street !== 'FINISHED' && latestHand.street !== 'SHOWDOWN')
        })
      if (!acted) return
      this.pending.delete(bot.id)
      return
    }

    if (!active || !seated.ready) {
      if (!active) return
      const key = `ready:${table.stateVersion}`
      const work = this.scheduled(bot.id, key, 1_000 + this.random() * 3_000)
      if (this.now() < work.dueAt) return
      const readied = await this.mutateWithConflictRecovery(bot, code, fence, room, 'ready',
        current => adapter.ready(bot.id, code, true, current, fence),
        current => {
          const currentSeat = current.pokerTable.players.find(player => player.playerId === bot.id)
          return current.visibility === 'PUBLIC' && Boolean(currentSeat && !currentSeat.ready && currentSeat.stack > 0)
        })
      if (!readied) return
      this.pending.delete(bot.id)
      return
    }
    const readyPlayers = table.players.filter(player => player.ready && !player.sittingOut && player.stack > 0)
    const ownsRoom = room.ownerId === bot.id
    if (ownsRoom && readyPlayers.length >= 2 && (!table.currentHand || table.currentHand.street === 'FINISHED')) {
      const key = `start:${table.stateVersion}`
      const work = this.scheduled(bot.id, key, 1_500 + this.random() * 4_500)
      if (this.now() < work.dueAt) return
      const observedHandSequence = table.handSequence
      const observedHandId = table.currentHand?.handId ?? null
      const started = await this.mutateWithConflictRecovery(bot, code, fence, room, 'start',
        current => adapter.startHand(bot.id, code, current.pokerTable.stateVersion, fence),
        current => {
          const currentTable = current.pokerTable
          if (currentTable.handSequence !== observedHandSequence
            || (currentTable.currentHand?.handId ?? null) !== observedHandId) return false
          const currentReady = currentTable.players.filter(player => player.ready && !player.sittingOut && player.stack > 0)
          return current.visibility === 'PUBLIC' && current.ownerId === bot.id && currentReady.length >= 2
            && (!currentTable.currentHand || currentTable.currentHand.street === 'FINISHED')
        })
      if (!started) return
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

function isConcurrencyConflict(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'CONFLICT' || code === 'STALE_STATE' || code === 'STALE_STATE_VERSION'
}

export function botLeaseDependencies(lease: OnlinePokerBotLease): OnlineRoomApiDependencies {
  return Object.freeze({ botFence: Object.freeze({ key: lease.leaseKey, token: lease.token }) })
}
