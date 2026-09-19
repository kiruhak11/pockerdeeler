import type {
  Prisma,
  Room as DbRoom,
  Player as DbPlayer,
  Hand as DbHand,
  PlayerAction as DbPlayerAction,
  GameSession as DbGameSession,
  AuditLog as DbAuditLog,
  RoomChatMessage as DbRoomChatMessage
} from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { generateSecret, hashSecret, verifySecret } from './authService'
import { generateRoomCode } from '../utils/roomCode'
import { verifyUserAuthToken } from './userAccountService'
import { hashLobbyPassword, verifyLobbyPassword } from './roomAccessService'
import type { BettingState } from '../../app/utils/bettingRounds'
import { revokeRoomParticipant } from '../ws/roomHub'
import { adjustUserWallet, ensureUserWallet, lockUserWallet, recordRoomLedger } from './walletService'
import { toChipBigInt, toChipNumber } from '../utils/chips'
import type { BuyInSettings, PredictionSettings, RoomSettings, RosterSettings } from '../../app/types/room'
import { ACHIEVEMENTS } from './achievementService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'

export interface CreateRoomPayload {
  accessMode?: 'public' | 'private'
  playerPolicy?: 'mixed' | 'accounts' | 'guests'
  password?: string
  name: string
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  quickBetSteps?: number[]
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
  authToken?: string
  buyIn?: Partial<BuyInSettings>
  predictions?: Partial<PredictionSettings>
  roster?: Partial<RosterSettings>
}

interface UpdateRoomSettingsPayload {
  dealerSecret: string
  startingStack?: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers?: number
  quickBetSteps?: number[]
  allowLateJoin?: boolean
  requireDealerActionApproval?: boolean
  allowSpectators?: boolean
  buyIn?: Partial<BuyInSettings>
  predictions?: Partial<PredictionSettings>
  roster?: Partial<RosterSettings>
}

const DEFAULT_QUICK_BET_STEPS = [50, 100, 500]

export interface RoomState {
  room: ReturnType<typeof mapRoom>
  players: ReturnType<typeof mapPlayer>[]
  currentSession: ReturnType<typeof mapSession> | null
  currentHand: ReturnType<typeof mapHand> | null
  actions: ReturnType<typeof mapAction>[]
  pendingActions: ReturnType<typeof mapAction>[]
  chatMessages: ReturnType<typeof mapChatMessage>[]
  lastDistribution: ReturnType<typeof mapLastDistribution> | null
}

function mapRoom(room: DbRoom) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    revision: room.revision,
    status: room.status as 'lobby' | 'active' | 'paused' | 'finished',
    dealerId: room.dealerId ?? '',
    hasPassword: Boolean(room.passwordHash),
    settings: parseRoomSettings(room.settings),
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString()
  }
}

function mapLastDistribution(log: DbAuditLog) {
  const payload = (log.payload || {}) as {
    handId?: string
    handNumber?: number
    winners?: { playerId: string; amountWon: number }[]
    deltas?: { playerId: string; delta: number; finalStack: number }[]
  }

  if (!payload.handId || typeof payload.handNumber !== 'number') {
    return null
  }

  return {
    eventId: log.id,
    handId: payload.handId,
    handNumber: payload.handNumber,
    createdAt: log.createdAt.toISOString(),
    winners: (payload.winners || []).map((winner) => ({
      playerId: winner.playerId,
      amountWon: winner.amountWon
    })),
    deltas: (payload.deltas || []).map((delta) => ({
      playerId: delta.playerId,
      delta: delta.delta,
      finalStack: delta.finalStack
    }))
  }
}

function mapPlayer(player: DbPlayer & { user?: { selectedAchievementCode: string | null; tableRating: number; predictionRating: number; premiumType: string; premiumSubscriptions: { plan: string }[]; achievements: { achievement: { code: string } }[]; seasonalRewards: { id: string }[] } | null }) {
  return {
    id: player.id,
    roomId: player.roomId,
    userId: player.userId ?? undefined,
    memberId: player.memberId ?? undefined,
    participantId: player.participantId ?? '',
    name: player.name,
    achievementIcon: player.user?.selectedAchievementCode || null,
    achievementIcons: [...(player.user?.seasonalRewards.map(item => `season:${item.id}`) ?? []), ...(player.user?.achievements.map(item => item.achievement.code) ?? [])],
    achievementCount: (player.user?.achievements.length ?? 0) + (player.user?.seasonalRewards.length ?? 0),
    tableRating: player.user?.tableRating,
    predictionRating: player.user?.predictionRating,
    premiumType: player.user?.premiumSubscriptions.length || player.user?.premiumType === 'PREMIUM' ? 'PREMIUM' as const : 'FREE' as const,
    seat: player.seat,
    stack: player.stack,
    currentBet: player.currentBet,
    totalCommitted: player.totalCommitted,
    status: player.status as 'waiting' | 'active' | 'checked' | 'folded' | 'all-in' | 'winner' | 'out',
    isConnected: player.isConnected,
    isAway: player.isAway,
    createdAt: player.createdAt.toISOString(),
    updatedAt: player.updatedAt.toISOString()
  }
}

function mapSession(session: DbGameSession) {
  return {
    id: session.id,
    roomId: session.roomId,
    status: session.status as 'lobby' | 'playing' | 'hand_finished' | 'finished',
    handNumber: session.handNumber,
    pot: session.pot,
    currentBet: session.currentBet,
    currentPlayerId: session.currentPlayerId ?? undefined,
    dealerButtonPlayerId: session.dealerButtonPlayerId ?? undefined,
    smallBlindPlayerId: session.smallBlindPlayerId ?? undefined,
    bigBlindPlayerId: session.bigBlindPlayerId ?? undefined,
    currentTurnStartedAt: session.currentTurnStartedAt?.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  }
}

function mapHand(hand: DbHand) {
  return {
    id: hand.id,
    roomId: hand.roomId,
    sessionId: hand.sessionId,
    handNumber: hand.handNumber,
    status: hand.status as 'active' | 'showdown' | 'finished',
    pot: hand.pot,
    currentBet: hand.currentBet,
    bettingState: hand.bettingState as unknown as BettingState | null,
    mainPotWinnerId: hand.mainPotWinnerId ?? undefined,
    mainPotSplit: hand.mainPotSplit,
    startedAt: hand.startedAt.toISOString(),
    finishedAt: hand.finishedAt?.toISOString()
  }
}

function mapAction(action: DbPlayerAction) {
  return {
    id: action.id,
    roomId: action.roomId,
    handId: action.handId,
    playerId: action.playerId,
    type: action.type as 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in',
    amount: action.amount,
    status: action.status as 'pending' | 'approved' | 'rejected' | 'applied',
    clientRequestId: action.clientRequestId,
    createdAt: action.createdAt.toISOString(),
    appliedAt: action.appliedAt?.toISOString(),
    street: action.street as import('../../app/utils/bettingRounds').Street | undefined,
    turnStartedAt: action.turnStartedAt?.toISOString(),
    requestedAt: action.requestedAt?.toISOString(),
    decisionTimeMs: action.decisionTimeMs ?? undefined
  }
}

function mapChatMessage(message: DbRoomChatMessage) {
  return {
    id: message.id,
    roomId: message.roomId,
    participantId: message.participantId ?? undefined,
    userId: message.userId ?? undefined,
    senderName: message.senderName,
    text: message.text,
    createdAt: message.createdAt.toISOString()
  }
}

function sanitizeQuickBetSteps(values?: number[]): number[] {
  const normalized = Array.isArray(values)
    ? values
      .map((value) => Math.trunc(value))
      .filter((value) => Number.isFinite(value) && value > 0 && value <= 1_000_000)
    : []

  const unique = [...new Set(normalized)]
  return unique.length ? unique.slice(0, 10) : [...DEFAULT_QUICK_BET_STEPS]
}

function defaultBuyIn(startingStack: number, enabled = false): BuyInSettings {
  return {
    enabled,
    minBuyIn: startingStack,
    maxBuyIn: startingStack,
    allowTopUp: false,
    topUpOnlyBetweenHands: true,
    maxActivePlayerSeatsPerAccount: 1
  }
}

function defaultPredictions(buyIn: BuyInSettings, enabled = false): PredictionSettings {
  return {
    enabled,
    question: 'main_pot_single_winner',
    grantMode: 'original_buy_in',
    minStake: 100,
    maxStake: 1000,
    maxStakePercentOfGrant: 20,
    marketOpenStreet: 'preflop',
    gracePeriodSeconds: 10,
    virtualLiquidityPerMarket: 1000,
    treasuryInitialBalance: 100000,
    behaviorImpact: 0.2,
    includeDecisionTime: false,
    hidePredictionsFromPlayers: true,
    comebackMinBuyIn: buyIn.minBuyIn,
    comebackMaxBuyIn: buyIn.maxBuyIn,
    maxReentriesPerMember: 1,
    requireDealerApprovalForReentry: true
  }
}

function defaultRoster(enabled = false): RosterSettings {
  return {
    requireDealerApproval: enabled,
    lockRosterAfterGameStart: enabled,
    allowDealerAccountRebinding: true
  }
}

export function parseRoomSettings(settings: Prisma.JsonValue): RoomSettings {
  const raw = (settings || {}) as Partial<RoomSettings>
  const smallBlind = typeof raw.smallBlind === 'number' && raw.smallBlind > 0 ? Math.trunc(raw.smallBlind) : 5
  const fallbackBigBlind = Math.max(smallBlind * 2, 10)
  const bigBlind = typeof raw.bigBlind === 'number' && raw.bigBlind > smallBlind
    ? Math.trunc(raw.bigBlind)
    : fallbackBigBlind
  const startingStack = typeof raw.startingStack === 'number' && raw.startingStack > 0 ? Math.trunc(raw.startingStack) : 1000
  const fallbackBuyIn = defaultBuyIn(startingStack)
  const buyInRaw = raw.buyIn
  const buyIn: BuyInSettings = {
    ...fallbackBuyIn,
    ...(buyInRaw || {}),
    enabled: buyInRaw?.enabled === true,
    minBuyIn: Math.max(1, Math.trunc(buyInRaw?.minBuyIn || fallbackBuyIn.minBuyIn)),
    maxBuyIn: Math.max(1, Math.trunc(buyInRaw?.maxBuyIn || fallbackBuyIn.maxBuyIn)),
    topUpOnlyBetweenHands: true,
    maxActivePlayerSeatsPerAccount: 1
  }
  if (buyIn.maxBuyIn < buyIn.minBuyIn) buyIn.maxBuyIn = buyIn.minBuyIn
  const predictionFallback = defaultPredictions(buyIn)
  const predictionRaw = raw.predictions
  const predictions: PredictionSettings = {
    ...predictionFallback,
    ...(predictionRaw || {}),
    enabled: predictionRaw?.enabled === true,
    question: 'main_pot_single_winner',
    marketOpenStreet: 'preflop',
    hidePredictionsFromPlayers: true,
    behaviorImpact: Math.min(0.35, Math.max(0, Number(predictionRaw?.behaviorImpact ?? predictionFallback.behaviorImpact)))
  }
  const roster = { ...defaultRoster(), ...(raw.roster || {}) }

  return {
    startingStack,
    accessMode: raw.accessMode === 'private' ? 'private' : 'public',
    playerPolicy: raw.playerPolicy === 'accounts' || raw.playerPolicy === 'guests' ? raw.playerPolicy : 'mixed',
    smallBlind,
    bigBlind,
    maxPlayers: typeof raw.maxPlayers === 'number' && raw.maxPlayers >= 2 ? Math.trunc(raw.maxPlayers) : 8,
    quickBetSteps: sanitizeQuickBetSteps(raw.quickBetSteps),
    allowLateJoin: Boolean(raw.allowLateJoin),
    requireDealerActionApproval: raw.requireDealerActionApproval !== false,
    allowSpectators: raw.allowSpectators !== false,
    buyIn,
    predictions,
    roster
  }
}

function normalizeSettings(payload: CreateRoomPayload): RoomSettings {
  const smallBlind = payload.smallBlind ?? 5
  const bigBlind = payload.bigBlind ?? Math.max(smallBlind * 2, 10)

  if (smallBlind <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'smallBlind должен быть больше 0' })
  }
  if (bigBlind <= smallBlind) {
    throw createError({ statusCode: 400, statusMessage: 'bigBlind должен быть больше smallBlind' })
  }

  const buyInDefaults = defaultBuyIn(payload.startingStack)
  const buyIn: BuyInSettings = {
    ...buyInDefaults,
    ...(payload.buyIn || {}),
    enabled: payload.buyIn?.enabled === true,
    topUpOnlyBetweenHands: true,
    maxActivePlayerSeatsPerAccount: 1
  }
  const predictions: PredictionSettings = {
    ...defaultPredictions(buyIn),
    ...(payload.predictions || {}),
    enabled: payload.predictions?.enabled === true,
    question: 'main_pot_single_winner',
    marketOpenStreet: 'preflop',
    hidePredictionsFromPlayers: true
  }
  const roster: RosterSettings = { ...defaultRoster(Boolean(payload.roster)), ...(payload.roster || {}) }
  validateExtendedSettings(buyIn, predictions)
  if (predictions.enabled && payload.playerPolicy === 'guests') {
    throw createError({ statusCode: 400, statusMessage: 'Прогнозы требуют аккаунты: выберите смешанный режим или только аккаунты' })
  }

  return {
    startingStack: payload.startingStack,
    accessMode: payload.accessMode ?? 'public',
    playerPolicy: payload.playerPolicy ?? 'mixed',
    smallBlind,
    bigBlind,
    maxPlayers: payload.maxPlayers,
    quickBetSteps: sanitizeQuickBetSteps(payload.quickBetSteps),
    allowLateJoin: payload.allowLateJoin,
    requireDealerActionApproval: payload.requireDealerActionApproval,
    allowSpectators: payload.allowSpectators,
    buyIn,
    predictions,
    roster
  }
}

function validateExtendedSettings(buyIn: BuyInSettings, predictions: PredictionSettings) {
  if (buyIn.minBuyIn <= 0 || buyIn.maxBuyIn < buyIn.minBuyIn) throw createError({ statusCode: 400, statusMessage: 'Проверьте диапазон бай-ина' })
  if (predictions.minStake <= 0 || predictions.maxStake < predictions.minStake) throw createError({ statusCode: 400, statusMessage: 'Проверьте диапазон прогнозов' })
  if (predictions.comebackMinBuyIn <= 0 || predictions.comebackMaxBuyIn < predictions.comebackMinBuyIn) throw createError({ statusCode: 400, statusMessage: 'Проверьте диапазон возврата' })
  if (predictions.behaviorImpact < 0 || predictions.behaviorImpact > 0.35) throw createError({ statusCode: 400, statusMessage: 'Влияние игровой оценки должно быть от 0 до 0,35' })
  if (predictions.enabled && predictions.treasuryInitialBalance < predictions.virtualLiquidityPerMarket) throw createError({ statusCode: 400, statusMessage: 'Резерв прогнозов должен покрывать хотя бы один рынок' })
}

async function createUniqueRoomCode(tx: Prisma.TransactionClient) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateRoomCode(6)
    const exists = await tx.room.findUnique({ where: { code: candidate }, select: { id: true } })
    if (!exists) {
      return candidate
    }
  }

  throw createError({ statusCode: 500, statusMessage: 'Не удалось сгенерировать код комнаты' })
}

export async function createRoom(payload: CreateRoomPayload, appUrl: string) {
  const settings = normalizeSettings(payload)
  const dealerSecret = generateSecret('dealer')
  const dealerSecretHash = hashSecret(dealerSecret)
  const verifiedUser = payload.authToken ? await verifyUserAuthToken(payload.authToken) : null
  if (payload.authToken && !verifiedUser) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  if (settings.accessMode === 'private' && (!payload.password || payload.password.length < 4)) throw createError({ statusCode: 400, statusMessage: 'Пароль комнаты должен содержать минимум 4 символа' })
  const passwordHash = settings.accessMode === 'private' ? await hashLobbyPassword(payload.password!) : null

  const created = await prisma.$transaction(async (tx) => {
    const dealerUser = verifiedUser
      ? await tx.user.findUnique({ where: { id: verifiedUser.userId } })
      : null

    if (verifiedUser && !dealerUser) {
      throw createError({ statusCode: 401, statusMessage: 'Аккаунт дилера не найден' })
    }

    const code = await createUniqueRoomCode(tx)

    const room = await tx.room.create({
      data: {
        code,
        name: payload.name,
        status: 'lobby',
        dealerSecretHash,
        passwordHash,
        settings: settings as unknown as Prisma.InputJsonValue
      }
    })

    const dealerParticipantFinal = await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: dealerUser?.id ?? null,
        role: 'dealer',
        name: dealerUser?.username || 'Dealer',
        sessionTokenHash: hashSecret(generateSecret('dealer')),
        isConnected: true
      }
    })

    await tx.room.update({
      where: { id: room.id },
      data: {
        dealerId: dealerParticipantFinal.id
      }
    })

    await tx.gameSession.create({
      data: {
        roomId: room.id,
        status: 'lobby',
        handNumber: 0,
        pot: 0,
        currentBet: 0
      }
    })

    if (settings.predictions.enabled) await tx.roomTreasury.create({ data: { roomId: room.id, balance: 0n } })

    return {
      room,
      dealerParticipant: dealerParticipantFinal
    }
  })

  const roomCode = created.room.code
  const base = appUrl.replace(/\/$/, '')
  void notifyAdminTelegram('games', `Создана игровая комната: ${created.dealerParticipant.name}, «${created.room.name}» (${roomCode}), ${new Date().toLocaleString('ru-RU')}.`)

  return {
    roomCode,
    dealerUrl: `${base}/room/${roomCode}/dealer?dealerSecret=${encodeURIComponent(dealerSecret)}`,
    joinUrl: `${base}/room/${roomCode}/join`,
    dealerSecret
  }
}

export async function verifyDealer(roomCode: string, dealerSecret: string) {
  const room = await prisma.room.findUnique({ where: { code: roomCode } })
  if (!room) {
    throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  }

  if (!verifySecret(dealerSecret, room.dealerSecretHash)) {
    throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
  }

  return room
}

export async function updateRoomSettingsByDealer(roomCode: string, payload: UpdateRoomSettingsPayload) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: roomCode } })

    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    if (!verifySecret(payload.dealerSecret, room.dealerSecretHash)) {
      throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
    }

    const current = parseRoomSettings(room.settings)
    const nextSettings: RoomSettings = {
      accessMode: current.accessMode,
      playerPolicy: current.playerPolicy,
      startingStack: payload.startingStack ?? current.startingStack,
      smallBlind: payload.smallBlind ?? current.smallBlind,
      bigBlind: payload.bigBlind ?? current.bigBlind,
      maxPlayers: payload.maxPlayers ?? current.maxPlayers,
      quickBetSteps: sanitizeQuickBetSteps(payload.quickBetSteps ?? current.quickBetSteps),
      allowLateJoin: payload.allowLateJoin ?? current.allowLateJoin,
      requireDealerActionApproval: payload.requireDealerActionApproval ?? current.requireDealerActionApproval,
      allowSpectators: payload.allowSpectators ?? current.allowSpectators,
      buyIn: { ...current.buyIn, ...(payload.buyIn || {}), topUpOnlyBetweenHands: true, maxActivePlayerSeatsPerAccount: 1 },
      predictions: {
        ...current.predictions,
        ...(payload.predictions || {}),
        question: 'main_pot_single_winner',
        marketOpenStreet: 'preflop',
        hidePredictionsFromPlayers: true
      },
      roster: { ...current.roster, ...(payload.roster || {}) }
    }

    if (nextSettings.startingStack <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Стартовый стек должен быть больше 0' })
    }

    if (!nextSettings.smallBlind || nextSettings.smallBlind <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'smallBlind должен быть больше 0' })
    }

    if (!nextSettings.bigBlind || nextSettings.bigBlind <= nextSettings.smallBlind) {
      throw createError({ statusCode: 400, statusMessage: 'bigBlind должен быть больше smallBlind' })
    }

    if (nextSettings.maxPlayers < 2 || nextSettings.maxPlayers > 10) {
      throw createError({ statusCode: 400, statusMessage: 'Максимум игроков должен быть в диапазоне 2-10' })
    }

    validateExtendedSettings(nextSettings.buyIn, nextSettings.predictions)

    const openMarket = await tx.predictionMarket.findFirst({ where: { roomId: room.id, status: { in: ['open', 'locked'] } } })
    if (openMarket && payload.predictions) {
      throw createError({ statusCode: 409, statusMessage: 'Настройки прогнозов можно изменить после расчёта текущего рынка' })
    }

    const treasury = await tx.roomTreasury.findUnique({ where: { roomId: room.id } })
    if (nextSettings.predictions.enabled && !treasury) await tx.roomTreasury.create({ data: { roomId: room.id, balance: 0n } })

    const playersCount = await tx.player.count({ where: { roomId: room.id, participantId: { not: null } } })
    if (nextSettings.maxPlayers < playersCount) {
      throw createError({
        statusCode: 409,
        statusMessage: `Нельзя установить максимум ${nextSettings.maxPlayers}: в комнате уже ${playersCount} игроков`
      })
    }

    await tx.room.update({
      where: { id: room.id },
      data: {
        settings: nextSettings as unknown as Prisma.InputJsonValue,
        revision: { increment: 1 },
        updatedAt: new Date()
      }
    })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'room.settings.updated',
        payload: nextSettings as unknown as Prisma.InputJsonValue
      }
    })
  })

  return getRoomState(roomCode)
}

export async function joinRoom(
  roomCode: string,
  name: string,
  role: 'player' | 'spectator' = 'player',
  authToken?: string,
  password?: string,
  requestedBuyIn?: number,
  clientRequestId: string = randomUUID()
) {
  const token = generateSecret('player')
  const tokenHash = hashSecret(token)
  const verifiedUser = authToken ? await verifyUserAuthToken(authToken) : null
  if (authToken && !verifiedUser) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  const accessRoom = await prisma.room.findUnique({ where: { code: roomCode } })
  if (!accessRoom) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  if (accessRoom.passwordHash && !await verifyLobbyPassword(password || '', accessRoom.passwordHash)) throw createError({ statusCode: 403, statusMessage: 'Неверный пароль комнаты' })

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    const settings = parseRoomSettings(room.settings)
    if (room.status === 'finished') throw createError({ statusCode: 409, statusMessage: 'Комната закрыта' })
    if (settings.playerPolicy === 'accounts' && !verifiedUser) throw createError({ statusCode: 403, statusMessage: 'Эта комната только для зарегистрированных пользователей' })
    if (settings.playerPolicy === 'guests' && verifiedUser) throw createError({ statusCode: 403, statusMessage: 'В эту комнату нужно войти как гость' })
    const user = verifiedUser
      ? await tx.user.findUnique({ where: { id: verifiedUser.userId } })
      : null

    if (verifiedUser && !user) {
      throw createError({ statusCode: 401, statusMessage: 'Аккаунт не найден' })
    }
    if (user) name = user.username
    if (!name.trim()) throw createError({ statusCode: 400, statusMessage: 'Введите имя' })

    if (user && role === 'player') {
      await lockUserWallet(tx, user.id)
      const duplicateBuyIn = await tx.buyIn.findFirst({
        where: { roomId: room.id, clientRequestId },
        include: { player: { include: { participant: true } }, member: true }
      })
      if (duplicateBuyIn?.player.participant) {
        const account = await tx.roomMemberAccount.findFirst({ where: { memberId: duplicateBuyIn.memberId, userId: user.id, isActive: true } })
        if (account) {
          const participant = await tx.roomParticipant.update({ where: { id: duplicateBuyIn.player.participant.id }, data: { sessionTokenHash: tokenHash, isConnected: true, lastSeenAt: new Date() } })
          const player = await tx.player.update({ where: { id: duplicateBuyIn.player.id }, data: { isConnected: true, isAway: false } })
          return { room, participant, player, memberState: duplicateBuyIn.member.state }
        }
      }

      const existing = await tx.player.findFirst({ where: { userId: user.id, OR: [{ participantId: { not: null } }, { totalCommitted: { gt: 0 }, balanceSettled: false }] }, include: { participant: true } })
      if (existing) {
        if (existing.roomId !== room.id || !existing.participant) throw createError({ statusCode: 409, statusMessage: 'Сначала выйдите из другой комнаты или дождитесь расчёта предыдущей раздачи' })
        const participant = await tx.roomParticipant.update({ where: { id: existing.participant.id }, data: { sessionTokenHash: tokenHash, isConnected: true, lastSeenAt: new Date() } })
        const player = await tx.player.update({ where: { id: existing.id }, data: { isAway: false } })
        const member = existing.memberId ? await tx.roomMember.findUnique({ where: { id: existing.memberId } }) : null
        return { room, participant, player, memberState: member?.state || 'playing' }
      }
    }

    if (role === 'spectator' && !settings.allowSpectators) {
      throw createError({ statusCode: 403, statusMessage: 'Зрители запрещены в этой комнате' })
    }

    if (role === 'player') {
      if (room.status !== 'lobby' && !settings.allowLateJoin && !settings.roster.lockRosterAfterGameStart) {
        throw createError({ statusCode: 409, statusMessage: 'Игра уже началась, поздний вход запрещен' })
      }

      const playerCount = await tx.player.count({
        where: {
          roomId: room.id,
          isConnected: true
        }
      })
      if (playerCount >= settings.maxPlayers) {
        throw createError({ statusCode: 409, statusMessage: 'Комната заполнена' })
      }
    }

    const duplicateName = await tx.roomParticipant.findFirst({
      where: {
        roomId: room.id,
        isConnected: true,
        role: { in: ['player', 'spectator'] },
        name: { equals: name, mode: 'insensitive' }
      }
    })

    if (duplicateName && (!user || duplicateName.userId !== user.id)) {
      throw createError({ statusCode: 409, statusMessage: 'Игрок с таким именем уже находится в комнате' })
    }

    let member = role === 'player'
      ? await tx.roomMember.findFirst({
        where: {
          roomId: room.id,
          ...(user
            ? { accounts: { some: { userId: user.id, isActive: true } } }
            : { displayName: { equals: name, mode: 'insensitive' }, state: 'left' })
        }
      })
      : null

    const needsApproval = role === 'player'
      && room.status !== 'lobby'
      && settings.roster.lockRosterAfterGameStart
      && settings.roster.requireDealerApproval

    if (needsApproval && !user) {
      throw createError({ statusCode: 409, statusMessage: 'После начала игры новые гости не добавляются. Войдите через аккаунт и отправьте запрос дилеру.' })
    }

    const buyInAmount = user && role === 'player'
      ? resolveBuyInAmount(settings, requestedBuyIn, toChipNumber((await ensureUserWallet(tx, user.id)).balance))
      : settings.startingStack

    if (!member && role === 'player') {
      member = await tx.roomMember.create({
        data: {
          roomId: room.id,
          displayName: name,
          state: needsApproval ? 'pending' : 'playing',
          approvedByParticipantId: needsApproval ? null : room.dealerId,
          requestedBuyIn: needsApproval ? BigInt(buyInAmount) : null,
          initialBuyIn: needsApproval ? null : BigInt(buyInAmount)
        }
      })
      if (user) await tx.roomMemberAccount.create({ data: { memberId: member.id, userId: user.id, boundByParticipantId: room.dealerId } })
    } else if (member) {
      member = await tx.roomMember.update({
        where: { id: member.id },
        data: needsApproval
          ? { state: 'pending', requestedBuyIn: BigInt(buyInAmount), updatedAt: new Date() }
          : { state: 'playing', initialBuyIn: member.initialBuyIn ?? BigInt(buyInAmount), requestedBuyIn: null, updatedAt: new Date() }
      })
    }

    const participant = await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: user?.id ?? null,
        memberId: member?.id,
        role: needsApproval ? 'spectator' : role,
        name,
        sessionTokenHash: tokenHash,
        isConnected: true
      }
    })

    let player: DbPlayer | null = null
    if (role === 'player' && !needsApproval && member) {
      const maxSeat = await tx.player.aggregate({
        where: { roomId: room.id },
        _max: { seat: true }
      })

      player = await tx.player.create({
        data: {
          roomId: room.id,
          userId: user?.id ?? null,
          memberId: member.id,
          participantId: participant.id,
          name,
          seat: (maxSeat._max.seat ?? 0) + 1,
          stack: buyInAmount,
          currentBet: 0,
          totalCommitted: 0,
          status: 'waiting',
          isConnected: true
        }
      })

      if (user) {
        const transferId = randomUUID()
        await adjustUserWallet(tx, {
          userId: user.id,
          delta: -BigInt(buyInAmount),
          entryType: 'BUY_IN_DEBIT',
          idempotencyKey: `buyin:${room.id}:${user.id}:${clientRequestId}`,
          transferId,
          roomId: room.id,
          memberId: member.id,
          metadata: { playerId: player.id, kind: 'initial' }
        })
        await tx.buyIn.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, amount: BigInt(buyInAmount), kind: 'initial', transferId, clientRequestId } })
        await recordRoomLedger(tx, {
          roomId: room.id,
          memberId: member.id,
          transferId,
          accountType: 'table_stack',
          entryType: 'BUY_IN_CREDIT',
          amount: BigInt(buyInAmount),
          balanceAfter: BigInt(buyInAmount),
          idempotencyKey: `buyin-credit:${room.id}:${member.id}:${clientRequestId}`,
          metadata: { playerId: player.id }
        })
      } else {
        await tx.buyIn.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, amount: BigInt(buyInAmount), kind: 'initial', transferId: randomUUID(), clientRequestId } })
      }
    }

    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: participant.id,
        actorRole: role,
        eventType: 'participant.joined',
        payload: {
          name,
          role: needsApproval ? 'spectator' : role,
          memberId: member?.id,
          buyInAmount: role === 'player' ? buyInAmount : undefined,
          needsApproval
        }
      }
    })

    return { room, participant, player, memberState: member?.state }
  })

  revokeRoomParticipant(result.room.code, result.participant.id)
  return {
    roomCode: result.room.code,
    playerId: result.player?.id,
    participantId: result.participant.id,
    memberState: result.memberState,
    playerSessionToken: token,
    playerUrl: role === 'player' && result.player
      ? `/room/${result.room.code}/player?playerId=${result.player?.id}`
      : `/room/${result.room.code}/table${result.memberState === 'pending' ? '?pending=1' : ''}`
  }
}

function resolveBuyInAmount(settings: RoomSettings, requested: number | undefined, walletBalance: number): number {
  if (!settings.buyIn.enabled) {
    if (walletBalance <= 0) throw createError({ statusCode: 409, statusMessage: 'В кошельке нет свободных фишек' })
    return walletBalance
  }
  const amount = Math.trunc(requested ?? settings.buyIn.minBuyIn)
  if (amount < settings.buyIn.minBuyIn || amount > settings.buyIn.maxBuyIn) {
    throw createError({ statusCode: 400, statusMessage: `Бай-ин должен быть от ${settings.buyIn.minBuyIn} до ${settings.buyIn.maxBuyIn}` })
  }
  if (amount > walletBalance) throw createError({ statusCode: 409, statusMessage: 'В кошельке недостаточно свободных фишек' })
  return amount
}

export async function resolveMemberEntryByDealer(input: {
  roomCode: string
  dealerSecret: string
  memberId: string
  decision: 'approve' | 'reject'
  rebindMemberId?: string
}) {
  let revokedParticipantId: string | null = null
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    if (!verifySecret(input.dealerSecret, room.dealerSecretHash)) throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
    await tx.$queryRaw`SELECT id FROM "room_members" WHERE id = CAST(${input.memberId} AS uuid) FOR UPDATE`
    const member = await tx.roomMember.findFirst({
      where: { id: input.memberId, roomId: room.id, state: 'pending' },
      include: { accounts: { where: { isActive: true } }, participants: { where: { isConnected: true }, orderBy: { joinedAt: 'desc' } } }
    })
    if (!member || !member.participants[0]) throw createError({ statusCode: 409, statusMessage: 'Запрос на вход уже обработан' })
    const participant = member.participants[0]
    const account = member.accounts[0]
    if (!account) throw createError({ statusCode: 409, statusMessage: 'У запроса нет подтверждённого аккаунта' })

    if (input.decision === 'reject') {
      revokedParticipantId = participant.id
      await tx.roomParticipant.update({ where: { id: participant.id }, data: { isConnected: false, lastSeenAt: new Date() } })
      await tx.roomMember.update({ where: { id: member.id }, data: { state: 'left', updatedAt: new Date() } })
    } else if (input.rebindMemberId) {
      const target = await tx.roomMember.findFirst({ where: { id: input.rebindMemberId, roomId: room.id }, include: { accounts: { where: { isActive: true } }, players: { orderBy: { createdAt: 'desc' } }, participants: { where: { isConnected: true } } } })
      if (!target || target.id === member.id) throw createError({ statusCode: 400, statusMessage: 'Участник для перепривязки не найден' })
      if (!target.players[0]) throw createError({ statusCode: 409, statusMessage: 'У прежнего участника нет места за столом' })
      const previousParticipant = target.participants.find(item => item.id !== participant.id)
      if (previousParticipant) {
        revokedParticipantId = previousParticipant.id
        await tx.roomParticipant.update({ where: { id: previousParticipant.id }, data: { isConnected: false, lastSeenAt: new Date() } })
      }
      await tx.roomMemberAccount.updateMany({ where: { memberId: target.id, isActive: true }, data: { isActive: false, endedAt: new Date() } })
      await tx.roomMemberAccount.update({ where: { id: account.id }, data: { memberId: target.id, boundByParticipantId: room.dealerId } })
      await tx.roomParticipant.update({ where: { id: participant.id }, data: { memberId: target.id, role: 'player', name: target.displayName } })
      const targetPlayer = target.players[0]
      await tx.player.update({ where: { id: targetPlayer.id }, data: { participantId: participant.id, userId: account.userId, isConnected: true, isAway: false, name: target.displayName } })
      await tx.roomMember.delete({ where: { id: member.id } })
    } else {
      const settings = parseRoomSettings(room.settings)
      const wallet = await lockUserWallet(tx, account.userId)
      const amount = resolveBuyInAmount(settings, member.requestedBuyIn ? toChipNumber(member.requestedBuyIn) : undefined, toChipNumber(wallet.balance))
      const playerCount = await tx.player.count({ where: { roomId: room.id, participantId: { not: null } } })
      if (playerCount >= settings.maxPlayers) throw createError({ statusCode: 409, statusMessage: 'Комната заполнена' })
      const maxSeat = await tx.player.aggregate({ where: { roomId: room.id }, _max: { seat: true } })
      const player = await tx.player.create({
        data: {
          roomId: room.id, memberId: member.id, userId: account.userId, participantId: participant.id,
          name: member.displayName, seat: (maxSeat._max.seat ?? 0) + 1, stack: amount,
          currentBet: 0, totalCommitted: 0, status: 'waiting', isConnected: true
        }
      })
      const transferId = randomUUID()
      const requestId = `dealer-approval:${member.id}`
      await adjustUserWallet(tx, {
        userId: account.userId, delta: -BigInt(amount), entryType: 'BUY_IN_DEBIT', idempotencyKey: `buyin:${room.id}:${account.userId}:${requestId}`,
        transferId, roomId: room.id, memberId: member.id, metadata: { playerId: player.id, approvedBy: room.dealerId }
      })
      await tx.buyIn.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, amount: BigInt(amount), kind: 'initial', transferId, clientRequestId: requestId } })
      await recordRoomLedger(tx, {
        roomId: room.id, memberId: member.id, transferId, accountType: 'table_stack', entryType: 'BUY_IN_CREDIT', amount: BigInt(amount),
        balanceAfter: BigInt(amount), idempotencyKey: `buyin-credit:${room.id}:${member.id}:${requestId}`, metadata: { playerId: player.id }
      })
      await tx.roomParticipant.update({ where: { id: participant.id }, data: { role: 'player' } })
      await tx.roomMember.update({ where: { id: member.id }, data: { state: 'playing', initialBuyIn: BigInt(amount), requestedBuyIn: null, approvedByParticipantId: room.dealerId, updatedAt: new Date() } })
    }

    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 }, updatedAt: new Date() } })
    await tx.auditLog.create({
      data: {
        roomId: room.id, actorParticipantId: room.dealerId, actorRole: 'dealer',
        eventType: input.decision === 'reject' ? 'member.rejected' : input.rebindMemberId ? 'member.account.rebound' : 'member.approved',
        payload: { memberId: member.id, rebindMemberId: input.rebindMemberId, userId: account.userId }
      }
    })
  })
  if (revokedParticipantId) revokeRoomParticipant(input.roomCode, revokedParticipantId)
  return getRoomState(input.roomCode)
}

export async function getBuyInOptions(roomCode: string, accountToken: string) {
  const auth = await verifyUserAuthToken(accountToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  return prisma.$transaction(async tx => {
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    const settings = parseRoomSettings(room.settings)
    const wallet = await ensureUserWallet(tx, auth.userId)
    const player = await tx.player.findFirst({ where: { roomId: room.id, userId: auth.userId, participantId: { not: null } }, orderBy: { createdAt: 'desc' } })
    return {
      enabled: settings.buyIn.enabled,
      minBuyIn: settings.buyIn.minBuyIn,
      maxBuyIn: settings.buyIn.maxBuyIn,
      allowTopUp: settings.buyIn.allowTopUp,
      walletBalance: toChipNumber(wallet.balance),
      currentStack: player?.stack ?? 0,
      maximumTopUp: player ? Math.max(0, Math.min(toChipNumber(wallet.balance), settings.buyIn.maxBuyIn - player.stack)) : 0
    }
  })
}

export async function topUpPlayer(input: { roomCode: string; accountToken: string; memberId: string; amount: number; clientRequestId: string }) {
  const auth = await verifyUserAuthToken(input.accountToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    const member = await tx.roomMember.findFirst({ where: { id: input.memberId, roomId: room.id, state: { in: ['playing', 'predicting'] }, accounts: { some: { userId: auth.userId, isActive: true } } } })
    if (!member) throw createError({ statusCode: 403, statusMessage: 'Участник не принадлежит этому аккаунту' })
    const existing = await tx.buyIn.findFirst({ where: { roomId: room.id, memberId: input.memberId, clientRequestId: input.clientRequestId } })
    if (existing) {
      if (existing.kind !== 'top_up' || existing.amount !== BigInt(input.amount)) throw createError({ statusCode: 409, statusMessage: 'Повторный запрос изменён' })
      return
    }
    const settings = parseRoomSettings(room.settings)
    if (!settings.buyIn.enabled || !settings.buyIn.allowTopUp) throw createError({ statusCode: 409, statusMessage: 'Пополнение стека отключено дилером' })
    if (await tx.hand.findFirst({ where: { roomId: room.id, status: { in: ['active', 'showdown'] } } })) throw createError({ statusCode: 409, statusMessage: 'Пополнить стек можно только между раздачами' })
    const player = await tx.player.findFirst({ where: { roomId: room.id, memberId: member.id, participantId: { not: null } }, orderBy: { createdAt: 'desc' } })
    if (!player) throw createError({ statusCode: 409, statusMessage: 'Активное место игрока не найдено' })
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || player.stack + input.amount > settings.buyIn.maxBuyIn) throw createError({ statusCode: 400, statusMessage: `После пополнения стек не должен превышать ${settings.buyIn.maxBuyIn}` })
    const transferId = randomUUID()
    await adjustUserWallet(tx, {
      userId: auth.userId, delta: -BigInt(input.amount), entryType: 'TOP_UP_DEBIT', idempotencyKey: `topup:${room.id}:${member.id}:${input.clientRequestId}`,
      transferId, roomId: room.id, memberId: member.id, metadata: { playerId: player.id }
    })
    const updated = await tx.player.update({ where: { id: player.id }, data: { stack: { increment: input.amount }, updatedAt: new Date() } })
    await tx.roomMember.update({ where: { id: member.id }, data: { state: 'playing' } })
    await tx.buyIn.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, amount: BigInt(input.amount), kind: 'top_up', transferId, clientRequestId: input.clientRequestId } })
    await recordRoomLedger(tx, {
      roomId: room.id, memberId: member.id, transferId, accountType: 'table_stack', entryType: 'TOP_UP_CREDIT', amount: BigInt(input.amount),
      balanceAfter: BigInt(updated.stack), idempotencyKey: `topup-credit:${room.id}:${member.id}:${input.clientRequestId}`
    })
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
  })
  return getRoomState(input.roomCode)
}

export async function returnPlayerStack(input: { roomCode: string; accountToken: string; memberId: string; amount: number; clientRequestId: string }) {
  const auth = await verifyUserAuthToken(input.accountToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw createError({ statusCode: 400, statusMessage: 'Некорректная сумма возврата' })
    const member = await tx.roomMember.findFirst({ where: { id: input.memberId, roomId: room.id, state: { in: ['playing', 'predicting'] }, accounts: { some: { userId: auth.userId, isActive: true } } } })
    if (!member) throw createError({ statusCode: 403, statusMessage: 'Участник не принадлежит этому аккаунту' })
    const duplicate = await tx.stackReturn.findFirst({ where: { roomId: room.id, memberId: member.id, clientRequestId: input.clientRequestId } })
    if (duplicate) {
      if (duplicate.userId !== auth.userId || duplicate.amount !== BigInt(input.amount)) throw createError({ statusCode: 409, statusMessage: 'Повторный запрос изменён' })
      return
    }
    if (await tx.hand.findFirst({ where: { roomId: room.id, status: { in: ['active', 'showdown'] } } })) throw createError({ statusCode: 409, statusMessage: 'Вернуть стек можно только между раздачами' })
    const player = await tx.player.findFirst({ where: { roomId: room.id, memberId: member.id, userId: auth.userId, participantId: { not: null } }, orderBy: { createdAt: 'desc' } })
    if (!player) throw createError({ statusCode: 409, statusMessage: 'Активный стек игрока не найден' })
    if (player.balanceSettled || player.totalCommitted || player.currentBet) throw createError({ statusCode: 409, statusMessage: 'Стек ещё участвует в расчёте раздачи' })
    if (input.amount > player.stack) throw createError({ statusCode: 400, statusMessage: 'Нельзя вернуть больше свободного стека' })
    const transferId = randomUUID()
    const updated = await tx.player.update({ where: { id: player.id }, data: { stack: { decrement: input.amount }, updatedAt: new Date() } })
    await adjustUserWallet(tx, { userId: auth.userId, delta: BigInt(input.amount), entryType: 'ROOM_STACK_RETURN', idempotencyKey: `stack-return:${room.id}:${member.id}:${input.clientRequestId}`, transferId, roomId: room.id, memberId: member.id, metadata: { playerId: player.id, roomName: room.name, roomCode: room.code, amount: input.amount } })
    await tx.stackReturn.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, userId: auth.userId, amount: BigInt(input.amount), transferId, clientRequestId: input.clientRequestId } })
    await recordRoomLedger(tx, { roomId: room.id, memberId: member.id, transferId, accountType: 'table_stack', entryType: 'STACK_RETURN_DEBIT', amount: -BigInt(input.amount), balanceAfter: BigInt(updated.stack), idempotencyKey: `stack-return-room:${room.id}:${member.id}:${input.clientRequestId}` })
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
  })
  return getRoomState(input.roomCode)
}

export async function verifyPlayerAccess(roomCode: string, playerId: string, token: string) {
  const room = await prisma.room.findUnique({ where: { code: roomCode }, select: { id: true } })
  if (!room) {
    throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  }

  const player = await prisma.player.findUnique({ where: { id: playerId } })
  if (!player || player.roomId !== room.id) {
    throw createError({ statusCode: 404, statusMessage: 'Игрок не найден' })
  }

  if (!player.participantId) {
    throw createError({ statusCode: 403, statusMessage: 'У игрока нет сессии участника' })
  }

  const participant = await prisma.roomParticipant.findUnique({ where: { id: player.participantId } })
  if (!participant || !verifySecret(token, participant.sessionTokenHash)) {
    throw createError({ statusCode: 403, statusMessage: 'Неверный токен игрока' })
  }

  return {
    roomId: room.id,
    roomCode,
    player,
    participant
  }
}

export async function getRoomState(roomCode: string): Promise<RoomState> {
  return prisma.$transaction(async tx => {
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }],
      include: { user: { select: { selectedAchievementCode: true, tableRating: true, predictionRating: true, premiumType: true, premiumSubscriptions: { where: { status: 'ACTIVE', startedAt: { lte: new Date() }, expiresAt: { gt: new Date() } }, select: { plan: true }, take: 1 }, achievements: { select: { achievement: { select: { code: true } } }, orderBy: { unlockedAt: 'desc' } }, seasonalRewards: { select: { id: true }, orderBy: { createdAt: 'desc' } } } } }
    })

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    const currentHand = session
      ? await tx.hand.findFirst({
          where: {
            sessionId: session.id,
            status: { in: ['active', 'showdown'] }
          },
          orderBy: { startedAt: 'desc' }
        })
      : null

    const actions = currentHand
      ? await tx.playerAction.findMany({
          where: { handId: currentHand.id },
          orderBy: { createdAt: 'asc' }
        })
      : []

    const pendingActions = actions.filter((action) => action.status === 'pending')
    const lastDistributionLog = await tx.auditLog.findFirst({
      where: {
        roomId: room.id,
        eventType: 'pot.distributed'
      },
      orderBy: { createdAt: 'desc' }
    })

    let lastDistribution: ReturnType<typeof mapLastDistribution> | null = null
    const mappedDistribution = lastDistributionLog ? mapLastDistribution(lastDistributionLog) : null
    if (mappedDistribution) {
      const distributionHand = await tx.hand.findUnique({
        where: { id: mappedDistribution.handId },
        select: { status: true }
      })

      if (distributionHand?.status === 'finished') {
        lastDistribution = mappedDistribution
      }
    }

    return {
      room: mapRoom(room),
      players: players.map(mapPlayer),
      currentSession: session ? mapSession(session) : null,
      currentHand: currentHand ? mapHand(currentHand) : null,
      actions: actions.map(mapAction),
      pendingActions: pendingActions.map(mapAction),
      // Chat history is Premium-gated in the dedicated endpoint. Never embed it
      // into the public room snapshot, otherwise non-Premium participants could
      // bypass that authorization boundary through REST or WebSocket state.
      chatMessages: [],
      lastDistribution
    }
  }, { isolationLevel: 'RepeatableRead' })
}
