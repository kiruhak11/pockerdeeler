import type { Player as DbPlayer, Hand, GameSession, Prisma, Room } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { recordAdminRoomMutation } from '../utils/adminContext'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifySecret, generateSecret, hashSecret } from './authService'
import { verifyUserAuthToken } from './userAccountService'
import { getRoomState, parseRoomSettings } from './roomService'
import { adjustUserWallet, recordRoomLedger, lockUserWallet } from './walletService'
import { openTokenRound, lockTokenRound, settleTokenRound, voidTokenRounds } from './tokenPredictionService'
import {
  ensurePredictionMarketLockedForReveal,
  issuePredictionGrantForEliminated,
  openPredictionMarketForHand,
  refreshPredictionMarketAfterAction,
  settlePredictionMarket,
  updateBehaviorStatsForHand,
  voidPredictionMarket
} from './predictionService'
import {
  applyPlayerAction,
  distributePot,
  sumCommitted,
  getAvailableActions,
  assertChipConservation
} from '../../app/utils/pokerCalculations'
import type { Player as CalcPlayer } from '../../app/types/game'
import { revokeRoomParticipant, closeRoomPeers } from '../ws/roomHub'
import { startBetting, afterAction, nextActor, revealNextStreet, validateRoundAction, removeFromBetting, type BettingState } from '../../app/utils/bettingRounds'
import { unlockAchievement, updateTableRatingAndAchievements } from './achievementService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'

function roundState(hand: Hand, players: CalcPlayer[], bigBlind = 10): BettingState {
  return hand.bettingState ? hand.bettingState as unknown as BettingState : startBetting(players, bigBlind, 'preflop', hand.currentBet)
}

async function persistBettingProgress(tx: Prisma.TransactionClient, room: Room, hand: Hand, session: GameSession, players: CalcPlayer[], actorId: string, pot: number, currentBet: number) {
  await lockTokenRound(tx, hand.id)
  const state = afterAction(roundState(hand, players), players, actorId, hand.currentBet, currentBet)
  const currentPlayerId = state.phase === 'betting' ? nextActor(players, state.pending, actorId) : null
  await tx.hand.update({ where: { id: hand.id }, data: { pot, currentBet, bettingState: state as unknown as Prisma.InputJsonValue } })
  await tx.gameSession.update({ where: { id: session.id }, data: { pot, currentBet, currentPlayerId, currentTurnStartedAt: currentPlayerId ? new Date() : null, updatedAt: new Date() } })
  const dbPlayers = await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } })
  await refreshPredictionMarketAfterAction(tx, room, hand, dbPlayers, state)
}

function validateRoundOrThrow(hand: Hand, players: CalcPlayer[], playerId: string, type: string, amount: number) {
  const player = players.find(p => p.id === playerId)
  if (!player) throw createError({ statusCode: 404, statusMessage: 'Игрок не найден' })
  try { validateRoundAction(roundState(hand, players), player, type, amount, hand.currentBet) }
  catch (error) { throw createError({ statusCode: 409, statusMessage: (error as Error).message }) }
}

interface DealerAuth {
  roomCode: string
  dealerSecret: string
}

function toCalcPlayers(players: DbPlayer[]): CalcPlayer[] {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    stack: player.stack,
    currentBet: player.currentBet,
    totalCommitted: player.totalCommitted,
    status: player.status as CalcPlayer['status'],
    seat: player.seat
  }))
}

async function lockRoomForUpdate(tx: Prisma.TransactionClient, roomCode: string) {
  await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${roomCode} FOR UPDATE`

  const room = await tx.room.findUnique({ where: { code: roomCode } })
  if (!room) {
    throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  }

  await recordAdminRoomMutation(tx, room)

  await tx.$queryRaw`SELECT id FROM "game_sessions" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "players" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "hands" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`
  await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 }, updatedAt: new Date() } })

  return room
}

function ensureDealerSecretOrThrow(hashedSecret: string, providedSecret: string) {
  if (!verifySecret(providedSecret, hashedSecret)) {
    throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
  }
}

function nextIndex(currentIndex: number, size: number): number {
  return (currentIndex + 1) % size
}

function getBlindPositions(activePlayers: DbPlayer[], previousDealerButtonPlayerId?: string | null) {
  if (activePlayers.length < 2) {
    throw createError({ statusCode: 409, statusMessage: 'Для раздачи нужно минимум 2 игрока с фишками' })
  }

  const dealerIndex = previousDealerButtonPlayerId
    ? activePlayers.findIndex((player) => player.id === previousDealerButtonPlayerId)
    : -1
  const nextDealerIndex = dealerIndex >= 0 ? nextIndex(dealerIndex, activePlayers.length) : 0

  const dealer = activePlayers[nextDealerIndex]
  if (!dealer) {
    throw createError({ statusCode: 409, statusMessage: 'Не удалось определить дилера' })
  }

  if (activePlayers.length === 2) {
    const other = activePlayers[nextIndex(nextDealerIndex, activePlayers.length)]
    if (!other) {
      throw createError({ statusCode: 409, statusMessage: 'Не удалось определить позиции блайндов' })
    }
    return {
      dealer,
      smallBlind: dealer,
      bigBlind: other
    }
  }

  const smallBlind = activePlayers[nextIndex(nextDealerIndex, activePlayers.length)]
  const bigBlind = activePlayers[nextIndex(nextIndex(nextDealerIndex, activePlayers.length), activePlayers.length)]
  if (!smallBlind || !bigBlind) {
    throw createError({ statusCode: 409, statusMessage: 'Не удалось определить позиции блайндов' })
  }

  return {
    dealer,
    smallBlind,
    bigBlind
  }
}

function applyBlind(player: DbPlayer, blindAmount: number) {
  const amount = Math.max(0, Math.min(player.stack, blindAmount))
  if (amount <= 0) {
    return 0
  }

  player.stack -= amount
  player.currentBet += amount
  player.totalCommitted += amount
  player.status = player.stack === 0 ? 'all-in' : 'active'
  return amount
}

function canPlayerAct(status: CalcPlayer['status'], stack: number): boolean {
  return stack > 0 && status !== 'folded' && status !== 'out' && status !== 'all-in'
}

function isConnectedTablePlayer(player: Pick<DbPlayer, 'isConnected' | 'participantId'>): boolean {
  return player.isConnected && Boolean(player.participantId)
}

function canParticipateInHand(player: Pick<DbPlayer, 'stack' | 'isConnected' | 'participantId' | 'isAway'>): boolean {
  return player.stack > 0 && !player.isAway && isConnectedTablePlayer(player)
}

function normalizePlayerStatusForActiveTable(player: Pick<DbPlayer, 'stack' | 'isConnected' | 'participantId' | 'status' | 'isAway'>) {
  player.status = canParticipateInHand(player) ? 'active' : 'out'
}

function getNextPlayerBySeat(
  orderedPlayers: DbPlayer[],
  playersAfterAction: CalcPlayer[],
  actedPlayerId: string
): DbPlayer | null {
  if (!orderedPlayers.length) {
    return null
  }

  const eligibleIds = new Set(
    playersAfterAction
      .filter((player) => canPlayerAct(player.status, player.stack))
      .map((player) => player.id)
  )

  if (!eligibleIds.size) {
    return null
  }

  const actedIndex = orderedPlayers.findIndex((player) => player.id === actedPlayerId)
  if (actedIndex < 0) {
    return orderedPlayers.find((player) => eligibleIds.has(player.id)) ?? null
  }

  for (let offset = 1; offset <= orderedPlayers.length; offset += 1) {
    const candidate = orderedPlayers[(actedIndex + offset) % orderedPlayers.length]
    if (candidate && eligibleIds.has(candidate.id)) {
      return candidate
    }
  }

  return null
}

function applyPlayerActionOrThrow(
  players: CalcPlayer[],
  pot: number,
  currentBet: number,
  input: {
    playerId: string
    type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'
    amount: number
  }
) {
  try {
    return applyPlayerAction(players, pot, currentBet, input)
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Некорректное действие'
    })
  }
}

async function savePlayers(tx: Prisma.TransactionClient, players: DbPlayer[]) {
  for (const player of players) {
    await tx.player.update({
      where: { id: player.id },
      data: {
        stack: player.stack,
        currentBet: player.currentBet,
        totalCommitted: player.totalCommitted,
        status: player.status,
        updatedAt: new Date()
      }
    })
  }
}

async function createSnapshot(
  tx: Prisma.TransactionClient,
  roomId: string,
  handId: string,
  snapshotType: 'before_action' | 'before_distribution' | 'manual',
  data: unknown
) {
  await tx.gameSnapshot.create({
    data: {
      roomId,
      handId,
      snapshotType,
      data: data as Prisma.InputJsonValue
    }
  })
}

export async function startGameByDealer({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)

    if (room.status !== 'lobby') throw createError({ statusCode: 409, statusMessage: 'Игра уже запущена' })

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    for (const player of players) {
      player.currentBet = 0
      player.totalCommitted = 0
      normalizePlayerStatusForActiveTable(player)
    }

    const readyPlayers = players.filter((player) => canParticipateInHand(player))
    if (readyPlayers.length < 2) {
      throw createError({ statusCode: 409, statusMessage: 'Нужно минимум 2 подключенных игрока с фишками' })
    }

    await savePlayers(tx, players)

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session) {
      await tx.gameSession.create({
        data: {
          roomId: room.id,
          status: 'playing',
          handNumber: 0,
          pot: 0,
          currentBet: 0
        }
      })
    } else {
      await tx.gameSession.update({
        where: { id: session.id },
        data: {
          status: 'playing',
          pot: 0,
          currentBet: 0,
          currentPlayerId: null
        }
      })
    }

    await tx.room.update({
      where: { id: room.id },
      data: {
        status: 'active',
        updatedAt: new Date()
      }
    })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'game.started',
        payload: {}
      }
    })
  })

  return getRoomState(roomCode)
}

export async function restartGameSamePlayersByDealer({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)
    if (await tx.hand.count({ where: { roomId: room.id, status: { in: ['active', 'showdown'] } } })) {
      throw createError({ statusCode: 409, statusMessage: 'Сначала распределите банк текущей раздачи' })
    }

    const settings = parseRoomSettings(room.settings)

    const players = await tx.player.findMany({
      where: { roomId: room.id, participantId: { not: null }, isConnected: true },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    if (!players.length) {
      throw createError({ statusCode: 409, statusMessage: 'В комнате нет игроков для перезапуска' })
    }

    const playersWithChips = players.filter((player) => player.stack > 0)
    if (playersWithChips.length !== 1) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Перезапуск доступен, когда за столом остался ровно один активный подключенный игрок'
      })
    }

    if (settings.predictions.enabled) {
      throw createError({ statusCode: 409, statusMessage: 'В этой комнате выбывшие возвращаются через прогнозы. Начните следующую раздачу или создайте новую комнату.' })
    }

    for (const player of players) {
      player.currentBet = 0
      player.totalCommitted = 0

      player.stack = settings.startingStack

      normalizePlayerStatusForActiveTable(player)
    }

    await savePlayers(tx, players)

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session) {
      await tx.gameSession.create({
        data: {
          roomId: room.id,
          status: 'playing',
          handNumber: 0,
          pot: 0,
          currentBet: 0,
          currentPlayerId: null
        }
      })
    } else {
      await tx.hand.updateMany({
        where: {
          sessionId: session.id,
          status: { in: ['active', 'showdown'] }
        },
        data: {
          status: 'finished',
          finishedAt: new Date(),
          pot: 0,
          currentBet: 0
        }
      })

      await tx.gameSession.update({
        where: { id: session.id },
        data: {
          status: 'playing',
          handNumber: 0,
          pot: 0,
          currentBet: 0,
          currentPlayerId: null,
          updatedAt: new Date()
        }
      })
    }

    await tx.room.update({
      where: { id: room.id },
      data: {
        status: 'active',
        updatedAt: new Date()
      }
    })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'game.restarted_same_players',
        payload: {
          players: players.map((player) => ({
            playerId: player.id,
            stack: player.stack
          }))
        } as unknown as Prisma.InputJsonValue
      }
    })
  })

  return getRoomState(roomCode)
}

export async function startHandByDealer({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)

    const settings = parseRoomSettings(room.settings)

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session || session.status !== 'playing') {
      throw createError({ statusCode: 409, statusMessage: 'Сессия не запущена' })
    }

    const existingActiveHand = await tx.hand.findFirst({
      where: {
        sessionId: session.id,
        status: { in: ['active', 'showdown'] }
      }
    })

    if (existingActiveHand) {
      throw createError({ statusCode: 409, statusMessage: 'Текущая раздача ещё не завершена' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    for (const player of players) {
      player.currentBet = 0
      player.totalCommitted = 0
      normalizePlayerStatusForActiveTable(player)
    }

    const activePlayers = players.filter((player) => canParticipateInHand(player))
    const blindPositions = getBlindPositions(activePlayers, session.dealerButtonPlayerId)

    const smallBlind = settings.smallBlind ?? 5
    const bigBlind = settings.bigBlind ?? Math.max(smallBlind * 2, 10)

    applyBlind(blindPositions.smallBlind, smallBlind)
    applyBlind(blindPositions.bigBlind, bigBlind)

    const pot = sumCommitted(toCalcPlayers(players))
    const currentBet = Math.max(...players.map((player) => player.currentBet), 0)

    const bettingState = startBetting(toCalcPlayers(players), bigBlind, 'preflop', currentBet)
    const firstToAct = nextActor(toCalcPlayers(players), bettingState.pending, blindPositions.bigBlind.id)

    await savePlayers(tx, players)

    const handNumber = session.handNumber + 1

    const hand = await tx.hand.create({
      data: {
        roomId: room.id,
        sessionId: session.id,
        handNumber,
        status: 'active',
        pot,
        currentBet,
        bettingState: bettingState as unknown as Prisma.InputJsonValue
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        handNumber,
        pot,
        currentBet,
        currentPlayerId: firstToAct,
        currentTurnStartedAt: firstToAct ? new Date() : null,
        dealerButtonPlayerId: blindPositions.dealer.id,
        smallBlindPlayerId: blindPositions.smallBlind.id,
        bigBlindPlayerId: blindPositions.bigBlind.id,
        updatedAt: new Date()
      }
    })

    await openPredictionMarketForHand(tx, room, hand, players)
    await openTokenRound(tx, room, hand, players)

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'hand.started',
        payload: {
          handNumber,
          smallBlindPlayerId: blindPositions.smallBlind.id,
          bigBlindPlayerId: blindPositions.bigBlind.id,
          pot,
          currentBet
        }
      }
    })

    await createSnapshot(tx, room.id, hand.id, 'manual', {
      reason: 'hand_start',
      players: toCalcPlayers(players).map(p => ({ ...p, stack: p.stack + p.totalCommitted, currentBet: 0, totalCommitted: 0 })),
      hand: {
        pot,
        currentBet,
        handNumber
      }
    })
  })

  return getRoomState(roomCode)
}

export async function requestPlayerAction(input: {
  roomCode: string
  playerId: string
  token: string
  type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'
  amount: number
  clientRequestId: string
  handId?: string
  expectedRevision?: number
}) {
  const txResult = await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, input.roomCode)

    const player = await tx.player.findUnique({ where: { id: input.playerId } })
    if (!player || player.roomId !== room.id) {
      throw createError({ statusCode: 404, statusMessage: 'Игрок не найден' })
    }

    if (!player.participantId) {
      throw createError({ statusCode: 403, statusMessage: 'Игрок не привязан к участнику' })
    }

    const participant = await tx.roomParticipant.findUnique({ where: { id: player.participantId } })
    if (!participant || !verifySecret(input.token, participant.sessionTokenHash)) {
      throw createError({ statusCode: 403, statusMessage: 'Неверный токен игрока' })
    }

    if (participant.userId) {
      const user = await tx.user.findUnique({ where: { id: participant.userId }, select: { blockedAt: true, deletedAt: true } })
      if (!user || user.blockedAt || user.deletedAt) throw createError({ statusCode: 403, statusMessage: 'Аккаунт недоступен' })
    }

    if (!participant.isConnected || !player.isConnected) {
      throw createError({ statusCode: 403, statusMessage: 'Сессия игрока неактивна' })
    }

    const existingByKey = await tx.playerAction.findUnique({
      where: {
        roomId_playerId_clientRequestId: {
          roomId: room.id,
          playerId: player.id,
          clientRequestId: input.clientRequestId
        }
      }
    })

    if (existingByKey) {
      return {
        success: true,
        action: existingByKey
      }
    }

    if (player.isAway) throw createError({ statusCode: 403, statusMessage: 'Игрок отошёл от стола' })
    // lockRoomForUpdate returns the committed revision BEFORE its increment.
    // Authenticate and resolve duplicates first, even for a previous hand.
    if (input.expectedRevision !== undefined && input.expectedRevision !== room.revision) {
      throw createError({ statusCode: 409, statusMessage: 'Состояние игры изменилось. Обновите игру перед действием.', data: { code: 'STALE_ACTION' } })
    }

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session || session.status !== 'playing') {
      throw createError({ statusCode: 409, statusMessage: 'Сессия не активна' })
    }

    const hand = await tx.hand.findFirst({
      where: {
        sessionId: session.id,
        status: { in: ['active', 'showdown'] }
      },
      orderBy: { startedAt: 'desc' }
    })

    if (!hand || hand.status !== 'active') {
      throw createError({ statusCode: 409, statusMessage: 'Активная раздача не найдена' })
    }

    if (input.handId !== undefined && input.handId !== hand.id) {
      throw createError({ statusCode: 409, statusMessage: 'Эта команда относится к другой раздаче.', data: { code: 'STALE_ACTION' } })
    }

    if (session.currentPlayerId !== player.id) {
      throw createError({ statusCode: 409, statusMessage: 'Сейчас ход другого игрока' })
    }

    const settings = parseRoomSettings(room.settings)

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    const calcPlayers = toCalcPlayers(players)
    const actingPlayer = calcPlayers.find((item) => item.id === player.id)
    if (!actingPlayer) {
      throw createError({ statusCode: 404, statusMessage: 'Игрок не найден в раздаче' })
    }

    const availability = getAvailableActions(actingPlayer, {
      currentBet: hand.currentBet,
      handActive: hand.status === 'active',
      isCurrentPlayer: true
    })

    const canUseAction = {
      check: availability.canCheck,
      call: availability.canCall,
      bet: availability.canBet,
      raise: availability.canRaise,
      fold: availability.canFold,
      'all-in': availability.canAllIn
    }[input.type]

    if (!canUseAction) {
      throw createError({ statusCode: 409, statusMessage: availability.disabledReason || 'Действие недоступно' })
    }

    validateRoundOrThrow(hand, calcPlayers, player.id, input.type, input.amount)
    applyPlayerActionOrThrow(calcPlayers, hand.pot, hand.currentBet, input)
    await lockTokenRound(tx, hand.id)
    const requestedAt = new Date()
    const decisionTimeMs = session.currentTurnStartedAt
      ? Math.max(0, requestedAt.getTime() - session.currentTurnStartedAt.getTime())
      : null
    const street = roundState(hand, calcPlayers).street

    if (settings.requireDealerActionApproval) {
      const existingPending = await tx.playerAction.findFirst({
        where: {
          roomId: room.id,
          handId: hand.id,
          playerId: player.id,
          status: 'pending'
        },
        orderBy: { createdAt: 'desc' }
      })

      if (existingPending) {
        throw createError({ statusCode: 409, statusMessage: 'Предыдущее действие ожидает подтверждения дилера' })
      }

      const pending = await tx.playerAction.create({
        data: {
          roomId: room.id,
          handId: hand.id,
          playerId: player.id,
          type: input.type,
          amount: input.amount,
          status: 'pending',
          clientRequestId: input.clientRequestId,
          street,
          turnStartedAt: session.currentTurnStartedAt,
          requestedAt,
          decisionTimeMs
        }
      })

      await tx.auditLog.create({
        data: {
          roomId: room.id,
          actorParticipantId: participant.id,
          actorRole: 'player',
          eventType: 'action.pending',
          payload: {
            actionId: pending.id,
            type: pending.type,
            amount: pending.amount
          }
        }
      })

      return {
        success: true,
        action: pending
      }
    }

    await createSnapshot(tx, room.id, hand.id, 'before_action', {
      players: calcPlayers,
      hand: {
        pot: hand.pot,
        currentBet: hand.currentBet,
        status: hand.status,
        bettingState: hand.bettingState
      },
      session: {
        pot: session.pot,
        currentBet: session.currentBet,
        status: session.status,
        currentPlayerId: session.currentPlayerId
      }
    })

    const result = applyPlayerActionOrThrow(calcPlayers, hand.pot, hand.currentBet, {
      playerId: player.id,
      type: input.type,
      amount: input.amount
    })

    const action = await tx.playerAction.create({
      data: {
        roomId: room.id,
        handId: hand.id,
        playerId: player.id,
        type: result.action.type,
        amount: result.action.amount,
        status: 'applied',
        clientRequestId: input.clientRequestId,
        appliedAt: new Date(),
        street,
        turnStartedAt: session.currentTurnStartedAt,
        requestedAt,
        decisionTimeMs
      }
    })

    for (const updated of result.players) {
      await tx.player.update({
        where: { id: updated.id },
        data: {
          stack: updated.stack,
          currentBet: updated.currentBet,
          totalCommitted: updated.totalCommitted,
          status: updated.status,
          updatedAt: new Date()
        }
      })
    }

    await persistBettingProgress(tx, room, hand, session, result.players, player.id, result.pot, result.currentBet)

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: participant.id,
        actorRole: 'player',
        eventType: 'action.applied',
        payload: {
          actionId: action.id,
          type: action.type,
          amount: action.amount
        }
      }
    })

    return {
      success: true,
      action
    }
  })

  return {
    ...txResult,
    state: await getRoomState(input.roomCode)
  }
}

export async function getPlayerActionStatus(input: { roomCode: string; playerId: string; token: string; clientRequestId: string }) {
  const result = await prisma.$transaction(async tx => {
    // Serialize the read behind any in-flight action without advancing revision.
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    const player = await tx.player.findUnique({ where: { id: input.playerId } })
    const participant = player?.participantId ? await tx.roomParticipant.findUnique({ where: { id: player.participantId } }) : null
    if (!player || player.roomId !== room.id || !player.isConnected || !participant?.isConnected || !verifySecret(input.token, participant.sessionTokenHash)) {
      throw createError({ statusCode: 403, statusMessage: 'Нет доступа к действиям игрока' })
    }
    if (participant.userId) {
      const user = await tx.user.findUnique({ where: { id: participant.userId }, select: { blockedAt: true, deletedAt: true } })
      if (!user || user.blockedAt || user.deletedAt) throw createError({ statusCode: 403, statusMessage: 'Аккаунт недоступен' })
    }
    const action = await tx.playerAction.findUnique({ where: { roomId_playerId_clientRequestId: {
      roomId: room.id, playerId: player.id, clientRequestId: input.clientRequestId
    } } })
    return { action, checkedRevision: room.revision }
  })
  return { ...result, state: await getRoomState(input.roomCode) }
}

export async function dealerForceActionForPlayer(input: {
  roomCode: string
  dealerSecret: string
  playerId: string
  type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'
  amount: number
}) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)

    const player = await tx.player.findUnique({ where: { id: input.playerId } })
    if (!player || player.roomId !== room.id) {
      throw createError({ statusCode: 404, statusMessage: 'Игрок не найден' })
    }

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session || session.status !== 'playing') {
      throw createError({ statusCode: 409, statusMessage: 'Сессия не активна' })
    }

    const hand = await tx.hand.findFirst({
      where: {
        sessionId: session.id,
        status: { in: ['active', 'showdown'] }
      },
      orderBy: { startedAt: 'desc' }
    })

    if (!hand || hand.status !== 'active') {
      throw createError({ statusCode: 409, statusMessage: 'Активная раздача не найдена' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })
    const calcPlayers = toCalcPlayers(players)
    if (!player.participantId || !player.isConnected || player.isAway || session.currentPlayerId !== player.id) throw createError({ statusCode: 409, statusMessage: 'Можно сделать ход только за текущего игрока' })
    validateRoundOrThrow(hand, calcPlayers, player.id, input.type, input.amount)
    await tx.playerAction.updateMany({ where: { handId: hand.id, playerId: player.id, status: 'pending' }, data: { status: 'rejected' } })

    await createSnapshot(tx, room.id, hand.id, 'before_action', {
      players: calcPlayers,
      hand: {
        pot: hand.pot,
        currentBet: hand.currentBet,
        status: hand.status,
        bettingState: hand.bettingState
      },
      session: {
        pot: session.pot,
        currentBet: session.currentBet,
        status: session.status,
        currentPlayerId: session.currentPlayerId
      }
    })

    const result = applyPlayerActionOrThrow(calcPlayers, hand.pot, hand.currentBet, {
      playerId: player.id,
      type: input.type,
      amount: input.amount
    })

    const action = await tx.playerAction.create({
      data: {
        roomId: room.id,
        handId: hand.id,
        playerId: player.id,
        type: result.action.type,
        amount: result.action.amount,
        status: 'approved',
        clientRequestId: `dealer-force-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        appliedAt: new Date(),
        street: roundState(hand, calcPlayers).street,
        turnStartedAt: session.currentTurnStartedAt,
        requestedAt: new Date()
      }
    })

    for (const updated of result.players) {
      await tx.player.update({
        where: { id: updated.id },
        data: {
          stack: updated.stack,
          currentBet: updated.currentBet,
          totalCommitted: updated.totalCommitted,
          status: updated.status,
          updatedAt: new Date()
        }
      })
    }

    await persistBettingProgress(tx, room, hand, session, result.players, player.id, result.pot, result.currentBet)

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'action.forced_by_dealer',
        payload: {
          actionId: action.id,
          playerId: player.id,
          type: action.type,
          amount: action.amount
        }
      }
    })
  })

  return getRoomState(input.roomCode)
}

export async function dealerResolvePendingAction(input: {
  roomCode: string
  dealerSecret: string
  pendingActionId: string
  decision: 'approve' | 'reject'
}) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)

    const pending = await tx.playerAction.findUnique({ where: { id: input.pendingActionId } })
    if (!pending || pending.roomId !== room.id || pending.status !== 'pending') {
      throw createError({ statusCode: 404, statusMessage: 'Ожидающее действие не найдено' })
    }

    if (input.decision === 'reject') {
      await tx.playerAction.update({
        where: { id: pending.id },
        data: { status: 'rejected' }
      })
      await tx.gameSession.updateMany({
        where: { roomId: room.id, currentPlayerId: pending.playerId },
        data: { currentTurnStartedAt: new Date(), updatedAt: new Date() }
      })

      await tx.auditLog.create({
        data: {
          roomId: room.id,
          actorParticipantId: room.dealerId,
          actorRole: 'dealer',
          eventType: 'action.rejected',
          payload: { actionId: pending.id }
        }
      })

      return
    }

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    const hand = await tx.hand.findUnique({ where: { id: pending.handId } })
    if (!session || !hand || hand.status !== 'active') {
      throw createError({ statusCode: 409, statusMessage: 'Раздача не активна' })
    }

    if (session.currentPlayerId !== pending.playerId) {
      throw createError({ statusCode: 409, statusMessage: 'Ожидающее действие уже не актуально: сменился ход' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    const calcPlayers = toCalcPlayers(players)
    validateRoundOrThrow(hand, calcPlayers, pending.playerId, pending.type, pending.amount)

    await createSnapshot(tx, room.id, hand.id, 'before_action', {
      players: calcPlayers,
      hand: {
        pot: hand.pot,
        currentBet: hand.currentBet,
        status: hand.status,
        bettingState: hand.bettingState
      },
      session: {
        pot: session.pot,
        currentBet: session.currentBet,
        status: session.status,
        currentPlayerId: session.currentPlayerId
      }
    })

    const result = applyPlayerActionOrThrow(calcPlayers, hand.pot, hand.currentBet, {
      playerId: pending.playerId,
      type: pending.type as 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in',
      amount: pending.amount
    })

    for (const updated of result.players) {
      await tx.player.update({
        where: { id: updated.id },
        data: {
          stack: updated.stack,
          currentBet: updated.currentBet,
          totalCommitted: updated.totalCommitted,
          status: updated.status,
          updatedAt: new Date()
        }
      })
    }

    await tx.playerAction.update({
      where: { id: pending.id },
      data: {
        type: result.action.type,
        amount: result.action.amount,
        status: 'approved',
        appliedAt: new Date()
      }
    })

    await persistBettingProgress(tx, room, hand, session, result.players, pending.playerId, result.pot, result.currentBet)

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'action.approved',
        payload: { actionId: pending.id }
      }
    })
  })

  return getRoomState(input.roomCode)
}

export async function finishHandByDealer({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session) {
      throw createError({ statusCode: 409, statusMessage: 'Сессия не найдена' })
    }

    const hand = await tx.hand.findFirst({
      where: {
        sessionId: session.id,
        status: 'active'
      },
      orderBy: { startedAt: 'desc' }
    })

    if (!hand) {
      throw createError({ statusCode: 409, statusMessage: 'Активная раздача не найдена' })
    }

    if (hand.bettingState && (hand.bettingState as unknown as BettingState).phase !== 'showdown') {
      throw createError({ statusCode: 409, statusMessage: 'Сначала завершите круг ставок и откройте общие карты' })
    }

    await tx.hand.update({
      where: { id: hand.id },
      data: {
        status: 'showdown'
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        status: 'hand_finished',
        currentPlayerId: null,
        updatedAt: new Date()
      }
    })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'hand.finished',
        payload: {
          handId: hand.id
        }
      }
    })
  })

  return getRoomState(roomCode)
}

export async function revealCardsByDealer(input: DealerAuth & { handId: string; street: string }) {
  await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)
    const hand = await tx.hand.findFirst({ where: { id: input.handId, roomId: room.id, status: 'active' } })
    if (!hand) throw createError({ statusCode: 409, statusMessage: 'Раздача уже изменилась' })
    const session = await tx.gameSession.findUniqueOrThrow({ where: { id: hand.sessionId } })
    const players = await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } })
    const current = roundState(hand, toCalcPlayers(players))
    if (current.street !== input.street || current.phase !== 'reveal') throw createError({ statusCode: 409, statusMessage: 'Эти карты уже открыты или ставки ещё не завершены' })
    await lockTokenRound(tx, hand.id)
    if (current.street === 'preflop') await ensurePredictionMarketLockedForReveal(tx, room, hand)
    for (const p of players) {
      p.currentBet = 0
      if (p.status === 'checked') p.status = 'active'
    }
    const next = revealNextStreet(current, toCalcPlayers(players), parseRoomSettings(room.settings).bigBlind ?? 10)
    await refreshPredictionMarketAfterAction(tx, room, hand, players, next)
    const nextPlayerId = next.phase === 'betting' ? nextActor(toCalcPlayers(players), next.pending, session.dealerButtonPlayerId) : null
    await savePlayers(tx, players)
    await tx.hand.update({ where: { id: hand.id }, data: { currentBet: 0, bettingState: next as unknown as Prisma.InputJsonValue } })
    await tx.gameSession.update({ where: { id: session.id }, data: { currentBet: 0, currentPlayerId: nextPlayerId, currentTurnStartedAt: nextPlayerId ? new Date() : null, updatedAt: new Date() } })
    // Physical cards cannot be hidden again: undo stops at the street boundary.
    await tx.gameSnapshot.deleteMany({ where: { handId: hand.id, snapshotType: 'before_action' } })
    await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: room.dealerId, actorRole: 'dealer', eventType: 'cards.revealed', payload: { handId: hand.id, street: next.street } } })
  })
  return getRoomState(input.roomCode)
}

export async function distributePotByDealer(input: {
  roomCode: string
  dealerSecret: string
  winners: string[]
  potWinners?: Record<string, string[]>
}) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)

    const session = await tx.gameSession.findFirst({
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!session) {
      throw createError({ statusCode: 409, statusMessage: 'Сессия не найдена' })
    }

    const hand = await tx.hand.findFirst({
      where: {
        sessionId: session.id,
        status: 'showdown'
      },
      orderBy: { startedAt: 'desc' }
    })

    if (!hand) {
      throw createError({ statusCode: 409, statusMessage: 'Раздача не в стадии showdown' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    const calcPlayers = toCalcPlayers(players)
    const totalBefore = calcPlayers.reduce((sum, player) => sum + player.stack + player.totalCommitted, 0)

    await createSnapshot(tx, room.id, hand.id, 'before_distribution', {
      players: calcPlayers,
      hand: {
        pot: hand.pot,
        currentBet: hand.currentBet,
        status: hand.status,
        bettingState: hand.bettingState
      },
      session: {
        pot: session.pot,
        currentBet: session.currentBet,
        status: session.status,
        currentPlayerId: session.currentPlayerId
      }
    })

    let distribution: ReturnType<typeof distributePot>
    try { distribution = distributePot(calcPlayers, input.winners, input.potWinners) }
    catch (error) { throw createError({ statusCode: 409, statusMessage: (error as Error).message }) }
    assertChipConservation(distribution.players, totalBefore)
    const predictors = await tx.tokenPrediction.findMany({ where: { round: { handId: hand.id } }, select: { userId: true } })
    for (const id of [...new Set([...players.map(p=>p.userId), ...predictors.map(p=>p.userId)].filter((id): id is string=>Boolean(id)))].sort()) await lockUserWallet(tx,id)
    const predictionPaid = await settleTokenRound(tx, room, hand, players, distribution.players, distribution.result.winners.map(w=>w.playerId))
    if (distribution.players.reduce((sum,p)=>sum+p.stack,0) + Number(predictionPaid) !== totalBefore) throw new Error('Poker/token chip conservation violated')
    const rewardRound = await tx.tokenPredictionRound.findUnique({ where: { handId: hand.id } })
    const rewardDeductions = (rewardRound?.deductions || {}) as Record<string,number>
    for (const winner of distribution.result.winners) winner.amountWon -= rewardDeductions[winner.playerId] || 0
    const mainPot = distribution.result.pots[0]
    const requestedMainWinners = input.potWinners?.['1'] || input.winners
    const mainPotWinnerIds = mainPot
      ? [...new Set((mainPot.eligiblePlayerIds.length === 1 ? mainPot.eligiblePlayerIds : requestedMainWinners)
        .filter(playerId => mainPot.eligiblePlayerIds.includes(playerId)))]
      : []

    const handStartSnapshot = await tx.gameSnapshot.findFirst({
      where: {
        roomId: room.id,
        handId: hand.id,
        snapshotType: 'manual'
      },
      orderBy: { createdAt: 'asc' }
    })

    const handStartPlayers = ((handStartSnapshot?.data || {}) as {
      players?: { id: string; stack: number }[]
    }).players || []
    const handStartStacks = new Map(handStartPlayers.map((player) => [player.id, player.stack]))
    const roomPlayersById = new Map(players.map((player) => [player.id, player]))

    for (const updated of distribution.players) {
      const source = roomPlayersById.get(updated.id)
      if (!source) {
        continue
      }

      if (!isConnectedTablePlayer(source)) {
        updated.status = 'out'
      }
    }

    const deltas = distribution.players.map((player) => {
      const startStack = handStartStacks.get(player.id) ?? 0
      return {
        playerId: player.id,
        delta: player.stack - startStack,
        finalStack: player.stack
      }
    })

    for (const updated of distribution.players) {
      await tx.player.update({
        where: { id: updated.id },
        data: {
          stack: updated.stack,
          currentBet: 0,
          totalCommitted: 0,
          status: updated.status,
          updatedAt: new Date()
        }
      })
    }

    for (const source of players.filter(player => !player.participantId && !player.balanceSettled && player.userId)) {
      const final = distribution.players.find(player => player.id === source.id)
      if (!final || final.stack <= 0) continue
      const transferId = randomUUID()
      await adjustUserWallet(tx, {
        userId: source.userId!, delta: BigInt(final.stack), entryType: 'TABLE_CASH_OUT',
        idempotencyKey: `cashout:distribution:${hand.id}:${source.id}`, transferId, roomId: room.id,
        memberId: source.memberId || undefined, metadata: { playerId: source.id, reason: 'detached_after_distribution' }
      })
      await recordRoomLedger(tx, {
        roomId: room.id, memberId: source.memberId || undefined, transferId, accountType: 'table_stack', entryType: 'TABLE_CASH_OUT_DEBIT',
        amount: -BigInt(final.stack), balanceAfter: 0n, idempotencyKey: `cashout-table:distribution:${hand.id}:${source.id}`
      })
      await tx.player.update({ where: { id: source.id }, data: { stack: 0, balanceSettled: true, status: 'out' } })
    }

    await tx.hand.update({
      where: { id: hand.id },
      data: {
        status: 'finished',
        finishedAt: new Date(),
        pot: 0,
        currentBet: 0,
        mainPotWinnerId: mainPotWinnerIds.length === 1 ? mainPotWinnerIds[0] : null,
        mainPotSplit: mainPotWinnerIds.length !== 1
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        status: 'playing',
        pot: 0,
        currentBet: 0,
        currentPlayerId: null,
        currentTurnStartedAt: null,
        updatedAt: new Date()
      }
    })

    await tx.handResult.deleteMany({ where: { handId: hand.id } })

    for (const winner of distribution.result.winners) {
      await tx.handResult.create({
        data: {
          handId: hand.id,
          playerId: winner.playerId,
          amountWon: winner.amountWon,
          potType: 'main'
        }
      })
    }

    for (const returned of distribution.result.returned) {
      await tx.handResult.create({
        data: {
          handId: hand.id,
          playerId: returned.playerId,
          amountWon: returned.amountWon,
          potType: 'side'
        }
      })
    }

    await settlePredictionMarket(tx, room, hand, mainPotWinnerIds)
    await updateBehaviorStatsForHand(tx, room.id, hand.id, mainPotWinnerIds, players)
    const ratingPots = distribution.result.pots.map(pot => {
      const selected = input.potWinners?.[String(pot.id)]
      const winners = pot.eligiblePlayerIds.length === 1 ? pot.eligiblePlayerIds : selected?.length ? selected : mainPotWinnerIds.filter(id => pot.eligiblePlayerIds.includes(id))
      const contributors = players.filter(player => player.totalCommitted >= pot.cap)
      return {
        amount: pot.amount,
        contributorPlayerIds: contributors.map(player => player.userId).filter((id): id is string => Boolean(id)),
        eligiblePlayerIds: pot.eligiblePlayerIds.map(id => players.find(player => player.id === id)?.userId).filter((id): id is string => Boolean(id)),
        foldedPlayerIds: contributors.filter(player => player.status === 'folded').map(player => player.userId).filter((id): id is string => Boolean(id)),
        winnerIds: winners.map(id => players.find(player => player.id === id)?.userId).filter((id): id is string => Boolean(id))
      }
    })
    await updateTableRatingAndAchievements(tx, hand.id, players, mainPotWinnerIds, ratingPots)

    for (const calculated of distribution.players) {
      const source = players.find(player => player.id === calculated.id)
      if (!source?.memberId) continue
      if (calculated.stack <= 0 && source.participantId) {
        if (source.userId) await unlockAchievement(tx, source.userId, 'busted_at_table')
        await issuePredictionGrantForEliminated(tx, room, { ...source, stack: calculated.stack, status: calculated.status })
      } else if (calculated.stack > 0) {
        await tx.roomMember.updateMany({ where: { id: source.memberId, state: { in: ['playing', 'spectating'] } }, data: { state: 'playing', updatedAt: new Date() } })
      }
    }

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'pot.distributed',
        payload: {
          handId: hand.id,
          handNumber: hand.handNumber,
          winners: distribution.result.winners,
          returned: distribution.result.returned,
          deltas
        } as unknown as Prisma.InputJsonValue
      }
    })
  })

  return getRoomState(input.roomCode)
}

export async function undoLastDealerAction({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)

    const snapshot = await tx.gameSnapshot.findFirst({
      where: { roomId: room.id, snapshotType: 'before_action', hand: { status: 'active' } },
      orderBy: { createdAt: 'desc' }
    })

    if (!snapshot) {
      throw createError({ statusCode: 409, statusMessage: 'Нет snapshot для отката' })
    }

    const market = snapshot.handId ? await tx.predictionMarket.findUnique({ where: { handId: snapshot.handId } }) : null
    if (snapshot.handId) await voidTokenRounds(tx, room.id, snapshot.handId)
    if (market?.status === 'locked') {
      throw createError({ statusCode: 409, statusMessage: 'Прогнозы уже зафиксированы; отмените раздачу целиком' })
    }
    if (market?.pricingMode === 'fixed_odds' && market.status === 'open' && await tx.predictionBet.count({ where: { marketId: market.id } })) {
      // Rewinding public information invalidates the forecast contract. Refund
      // tickets rather than silently reprice them or leave exploitable stale odds.
      await voidPredictionMarket(tx, market, 'poker_action_undone')
    }

    const data = snapshot.data as {
      players?: CalcPlayer[]
      hand?: {
        pot: number
        currentBet: number
        bettingState?: Prisma.InputJsonValue
        status?: 'active' | 'showdown' | 'finished'
      }
      session?: {
        pot: number
        currentBet: number
        status?: 'lobby' | 'playing' | 'hand_finished' | 'finished'
        currentPlayerId?: string | null
      }
    }

    if (!data.players || !snapshot.handId) {
      throw createError({ statusCode: 409, statusMessage: 'Snapshot не содержит данных для undo' })
    }

    for (const player of data.players) {
      await tx.player.update({
        where: { id: player.id },
        data: {
          stack: player.stack,
          currentBet: player.currentBet,
          totalCommitted: player.totalCommitted,
          status: player.status,
          updatedAt: new Date()
        }
      })
    }

    if (data.hand) {
      const handStatus = data.hand.status
        ? data.hand.status
        : snapshot.snapshotType === 'before_distribution'
          ? 'showdown'
          : 'active'

      await tx.hand.update({
        where: { id: snapshot.handId },
        data: {
          pot: data.hand.pot,
          currentBet: data.hand.currentBet,
          status: handStatus,
          bettingState: data.hand.bettingState ?? undefined,
          finishedAt: handStatus === 'finished' ? new Date() : null
        }
      })

      const session = await tx.gameSession.findFirst({
        where: { roomId: room.id },
        orderBy: { createdAt: 'desc' }
      })

      if (session) {
        await tx.gameSession.update({
          where: { id: session.id },
          data: {
            pot: data.session?.pot ?? data.hand.pot,
            currentBet: data.session?.currentBet ?? data.hand.currentBet,
            status: data.session?.status ?? (snapshot.snapshotType === 'before_distribution' ? 'hand_finished' : 'playing'),
            currentPlayerId: data.session?.currentPlayerId ?? null,
            updatedAt: new Date()
          }
        })
      }
    }

    if (snapshot.snapshotType === 'before_action') {
      const lastAppliedAction = await tx.playerAction.findFirst({
        where: {
          handId: snapshot.handId,
          status: { in: ['applied', 'approved'] }
        },
        orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }]
      })

      if (lastAppliedAction) {
        await tx.playerAction.update({
          where: { id: lastAppliedAction.id }, data: { status: 'rejected' }
        })
      }
    }

    if (snapshot.snapshotType === 'before_distribution') {
      await tx.handResult.deleteMany({
        where: { handId: snapshot.handId }
      })
    }

    await tx.gameSnapshot.delete({ where: { id: snapshot.id } })
    await tx.playerAction.updateMany({ where: { roomId: room.id, status: 'pending' }, data: { status: 'rejected' } })

    if (market?.status === 'open' && snapshot.handId) {
      const restoredHand = await tx.hand.findUniqueOrThrow({ where: { id: snapshot.handId } })
      const restoredPlayers = await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } })
      await refreshPredictionMarketAfterAction(tx, room, restoredHand, restoredPlayers, roundState(restoredHand, toCalcPlayers(restoredPlayers)))
    }

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'undo.applied',
        payload: {
          snapshotId: snapshot.id
        }
      }
    })
  })

  return getRoomState(roomCode)
}

async function departParticipant(tx: Prisma.TransactionClient, roomId: string, participantId: string) {
  const player = await tx.player.findUnique({ where: { participantId } })
  const participant = await tx.roomParticipant.findUnique({ where: { id: participantId } })
  const session = await tx.gameSession.findFirst({ where: { roomId }, orderBy: { createdAt: 'desc' } })
  const hand = session && await tx.hand.findFirst({ where: { sessionId: session.id, status: { in: ['active', 'showdown'] } }, orderBy: { startedAt: 'desc' } })
  await tx.roomParticipant.update({ where: { id: participantId }, data: { isConnected: false, lastSeenAt: new Date() } })
  if (!player) {
    if (participant?.memberId) await tx.roomMember.update({ where: { id: participant.memberId }, data: { state: 'left', updatedAt: new Date() } })
    return
  }
  const betting = hand?.bettingState as unknown as BettingState | null
  const unresolved = Boolean(hand && (player.status === 'all-in' || hand.status === 'showdown' || betting?.phase === 'showdown') && player.totalCommitted > 0)
  const status = unresolved ? player.status : hand && player.status !== 'waiting' && player.status !== 'out' ? 'folded' : 'out'
  let stackAfterDeparture = player.stack
  if (player.userId && !unresolved && player.stack > 0) {
    const transferId = randomUUID()
    await adjustUserWallet(tx, {
      userId: player.userId, delta: BigInt(player.stack), entryType: 'TABLE_CASH_OUT',
      idempotencyKey: `cashout:departure:${player.id}`, transferId, roomId, memberId: player.memberId || undefined,
      metadata: { playerId: player.id, reason: 'participant_left' }
    })
    await recordRoomLedger(tx, {
      roomId, memberId: player.memberId || undefined, transferId, accountType: 'table_stack', entryType: 'TABLE_CASH_OUT_DEBIT',
      amount: -BigInt(player.stack), balanceAfter: 0n, idempotencyKey: `cashout-table:departure:${player.id}`
    })
    stackAfterDeparture = 0
  }
  // Keep the financial record for pot calculation/history, but detach the live seat.
  await tx.player.update({ where: { id: player.id }, data: { participantId: null, isConnected: false, stack: stackAfterDeparture, status, balanceSettled: !unresolved } })
  if (player.memberId) await tx.roomMember.update({ where: { id: player.memberId }, data: { state: 'left', updatedAt: new Date() } })
  await tx.playerAction.updateMany({ where: { roomId, playerId: player.id, status: 'pending' }, data: { status: 'rejected' } })
  await tx.gameSnapshot.deleteMany({ where: { roomId, snapshotType: 'before_action' } })
  if (session && hand?.status === 'active') {
    const players = toCalcPlayers(await tx.player.findMany({ where: { roomId }, orderBy: { seat: 'asc' } }))
    const state = removeFromBetting(roundState(hand, players), players, player.id, hand.currentBet)
    const predictionRoom = await tx.room.findUniqueOrThrow({ where: { id: roomId } })
    const dbPlayers = await tx.player.findMany({ where: { roomId }, orderBy: { seat: 'asc' } })
    await refreshPredictionMarketAfterAction(tx, predictionRoom, hand, dbPlayers, state)
    const currentPlayerId = state.phase !== 'betting' ? null : session.currentPlayerId && state.pending.includes(session.currentPlayerId)
      ? session.currentPlayerId : nextActor(players, state.pending, player.id)
    await tx.hand.update({ where: { id: hand.id }, data: { bettingState: state as unknown as Prisma.InputJsonValue } })
    await tx.gameSession.update({ where: { id: session.id }, data: { currentPlayerId, currentTurnStartedAt: currentPlayerId ? new Date() : null, updatedAt: new Date() } })
  }
}

async function deleteEmptyRoom(tx: Prisma.TransactionClient, roomId: string) {
  if (await tx.player.count({ where: { roomId, participantId: { not: null } } })) return false
  await cancelAndDeleteRoom(tx, roomId)
  return true
}

async function cancelAndDeleteRoom(tx: Prisma.TransactionClient, roomId: string, archive = false) {
  await voidTokenRounds(tx, roomId)
  if (archive) {
    const players = await tx.player.findMany({ where: { roomId } })
    await tx.gameSnapshot.create({ data: { roomId, snapshotType: 'admin_archive', data: JSON.parse(JSON.stringify({ players })) as Prisma.InputJsonValue } })
  }
  const markets = await tx.predictionMarket.findMany({ where: { roomId, status: { in: ['scheduled', 'open', 'locked'] } }, orderBy: { createdAt: 'asc' } })
  for (const market of markets) await voidPredictionMarket(tx, market, 'room_deleted')

  const players = await tx.player.findMany({ where: { roomId, userId: { not: null } } })
  const userIds = [...new Set(players.map(p => p.userId!))].sort()
  for (const userId of userIds) {
    const records = players.filter(p => p.userId === userId)
    const refund = records.reduce((sum, player) => sum + player.totalCommitted + (player.balanceSettled ? 0 : player.stack), 0)
    if (refund <= 0) continue
    const memberId = records.find(player => player.memberId)?.memberId || undefined
    const transferId = randomUUID()
    await adjustUserWallet(tx, {
      userId, delta: BigInt(refund), entryType: 'ROOM_CANCEL_REFUND', idempotencyKey: `room-cancel-refund:${roomId}:${userId}`,
      transferId, roomId, memberId, metadata: { playerIds: records.map(player => player.id) }
    })
    await recordRoomLedger(tx, {
      roomId, memberId, transferId, accountType: 'table_stack', entryType: 'ROOM_CANCEL_REFUND_DEBIT',
      amount: -BigInt(refund), balanceAfter: 0n, idempotencyKey: `room-cancel-table:${roomId}:${userId}`
    })
  }
  if (archive) {
    await tx.player.updateMany({ where: { roomId }, data: { stack: 0, currentBet: 0, totalCommitted: 0, status: 'out', balanceSettled: true, isConnected: false, participantId: null } })
    await tx.roomParticipant.updateMany({ where: { roomId }, data: { isConnected: false, sessionTokenHash: hashSecret(generateSecret('player')) } })
    await tx.roomMember.updateMany({ where: { roomId }, data: { state: 'left' } })
    await tx.playerAction.updateMany({ where: { roomId, status: 'pending' }, data: { status: 'rejected' } })
    await tx.hand.updateMany({ where: { roomId, status: { in: ['active', 'showdown'] } }, data: { status: 'cancelled', finishedAt: new Date(), pot: 0, currentBet: 0 } })
    await tx.gameSession.updateMany({ where: { roomId }, data: { status: 'finished', pot: 0, currentBet: 0, currentPlayerId: null } })
    await tx.room.update({ where: { id: roomId }, data: { status: 'finished', dealerSecretHash: hashSecret(generateSecret('dealer')) } })
  } else await tx.room.delete({ where: { id: roomId } })
}

export async function archiveRoomByAdmin({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)
    if (room.status === 'finished') throw createError({ statusCode: 409, message: 'Комната уже завершена' })
    await cancelAndDeleteRoom(tx, room.id, true)
  })
  closeRoomPeers(roomCode)
  const archived = await prisma.room.findUnique({ where: { code: roomCode }, select: { name: true, code: true, dealerId: true } })
  const dealer = archived?.dealerId ? await prisma.roomParticipant.findUnique({ where: { id: archived.dealerId }, select: { name: true } }) : null
  if (archived) void notifyAdminTelegram('games', `Закрыта игровая комната: ${dealer?.name || 'Dealer'}, «${archived.name}» (${archived.code}), ${new Date().toLocaleString('ru-RU')}.`)
}

export async function pauseRoomByAdmin(input: DealerAuth & { paused: boolean }) {
  await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)
    if (!['active', 'paused'].includes(room.status)) throw createError({ statusCode: 409, message: 'Игра ещё не началась или завершена' })
    await tx.room.update({ where: { id: room.id }, data: { status: input.paused ? 'paused' : 'active' } })
  })
  return getRoomState(input.roomCode)
}

export async function deleteRoomByDealer({ roomCode, dealerSecret }: DealerAuth) {
  const closed = await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)
    const dealer = room.dealerId ? await tx.roomParticipant.findUnique({ where: { id: room.dealerId }, select: { name: true } }) : null
    await cancelAndDeleteRoom(tx, room.id)
    return { name: room.name, code: room.code, dealer: dealer?.name || 'Dealer' }
  })
  closeRoomPeers(roomCode)
  void notifyAdminTelegram('games', `Закрыта игровая комната: ${closed.dealer}, «${closed.name}» (${closed.code}), ${new Date().toLocaleString('ru-RU')}.`)
}

async function accountIdOrThrow(token: string): Promise<string> {
  const auth = await verifyUserAuthToken(token)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  return auth.userId
}

export async function getAccountRooms(token: string) {
  const userId = await accountIdOrThrow(token)
  const seats = await prisma.player.findMany({
    where: { userId, participantId: { not: null }, isConnected: true },
    include: { room: true }, orderBy: { createdAt: 'desc' }
  })
  return seats.map(p => ({ roomCode: p.room.code, name: p.room.name, status: p.room.status,
    playerId: p.id, stack: p.stack, isAway: p.isAway }))
}

export async function setPlayerAway(roomCode: string, token: string) {
  const userId = await accountIdOrThrow(token)
  let participantId: string | null = null
  await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, roomCode)
    const player = await tx.player.findFirst({ where: { roomId: room.id, userId, participantId: { not: null }, isConnected: true } })
    if (!player) throw createError({ statusCode: 403, statusMessage: 'У аккаунта нет места в этой комнате' })
    participantId = player.participantId
    if (player.isAway) return
    const session = await tx.gameSession.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' } })
    const hand = session && await tx.hand.findFirst({ where: { sessionId: session.id, status: { in: ['active', 'showdown'] } }, orderBy: { startedAt: 'desc' } })
    const playersBefore = await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } })
    const round = hand ? roundState(hand, toCalcPlayers(playersBefore)) : null
    const canFold = hand?.status === 'active' && round?.phase !== 'showdown' && ['active', 'checked'].includes(player.status)
    await tx.player.update({ where: { id: player.id }, data: { isAway: true, ...(canFold ? { status: 'folded' } : {}) } })
    await tx.playerAction.updateMany({ where: { playerId: player.id, status: 'pending' }, data: { status: 'rejected' } })
    // Presence changes are an undo boundary: restoring an old action must not revive an absent hand.
    await tx.gameSnapshot.deleteMany({ where: { roomId: room.id, snapshotType: 'before_action' } })
    if (hand?.status === 'active' && session && round && round.phase !== 'showdown') {
      const players = toCalcPlayers(await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } }))
      const betting = removeFromBetting(round, players, player.id, hand.currentBet)
      const dbPlayers = await tx.player.findMany({ where: { roomId: room.id }, orderBy: { seat: 'asc' } })
      await refreshPredictionMarketAfterAction(tx, room, hand, dbPlayers, betting)
      const currentPlayerId = betting.phase !== 'betting' ? null : session.currentPlayerId && betting.pending.includes(session.currentPlayerId)
        ? session.currentPlayerId : nextActor(players, betting.pending, player.id)
      await tx.hand.update({ where: { id: hand.id }, data: { bettingState: betting as unknown as Prisma.InputJsonValue } })
      await tx.gameSession.update({ where: { id: session.id }, data: { currentPlayerId, currentTurnStartedAt: currentPlayerId ? new Date() : null } })
    }
    await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: player.participantId, actorRole: 'player', eventType: 'player.away', payload: { playerId: player.id, folded: canFold } } })
  })
  if (participantId) revokeRoomParticipant(roomCode, participantId, 4005)
  return getRoomState(roomCode)
}

export async function resumeAccountRoom(roomCode: string, token: string) {
  const userId = await accountIdOrThrow(token)
  const playerSessionToken = generateSecret('player')
  const player = await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, roomCode)
    const seat = await tx.player.findFirst({ where: { roomId: room.id, userId, participantId: { not: null }, isConnected: true } })
    if (!seat?.participantId) throw createError({ statusCode: 403, statusMessage: 'Место не сохранено. Войдите в комнату заново.' })
    // This restores membership, not a new buy-in. No password/late-join bypass for new players.
    await tx.roomParticipant.update({ where: { id: seat.participantId }, data: { sessionTokenHash: hashSecret(playerSessionToken), lastSeenAt: new Date() } })
    await tx.player.update({ where: { id: seat.id }, data: { isAway: false } })
    await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: seat.participantId, actorRole: 'player', eventType: 'player.returned', payload: { playerId: seat.id } } })
    return seat
  })
  revokeRoomParticipant(roomCode, player.participantId!, 4005)
  return { roomCode, playerId: player.id, participantId: player.participantId!, playerSessionToken, playerUrl: `/room/${roomCode}/player`, state: await getRoomState(roomCode) }
}

export async function kickPlayerByDealer(input: { roomCode: string; dealerSecret: string; playerId: string }) {
  let revoked: string | null = null
  const deleted = await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)
    const player = await tx.player.findFirst({ where: { id: input.playerId, roomId: room.id } })
    if (!player?.participantId) throw createError({ statusCode: 404, statusMessage: 'Игрок уже вышел из комнаты' })
    revoked = player.participantId
    await departParticipant(tx, room.id, player.participantId)
    await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: room.dealerId, actorRole: 'dealer', eventType: 'player.kicked', payload: { playerId: player.id } } })
    return deleteEmptyRoom(tx, room.id)
  })
  if (revoked) revokeRoomParticipant(input.roomCode, revoked)
  if (deleted) { closeRoomPeers(input.roomCode); return null }
  return getRoomState(input.roomCode)
}

export async function leaveRoom(input: { roomCode: string; participantId?: string; playerId?: string; token?: string; dealerSecret?: string; authToken?: string }) {
  let revoked: string | null = null
  const deleted = await prisma.$transaction(async tx => {
    const room = await lockRoomForUpdate(tx, input.roomCode)
    if (input.dealerSecret) {
      ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)
      if (room.dealerId) await tx.roomParticipant.update({ where: { id: room.dealerId }, data: { isConnected: false, lastSeenAt: new Date() } })
    } else if (input.authToken) {
      const userId = await accountIdOrThrow(input.authToken)
      const player = await tx.player.findFirst({ where: { roomId: room.id, userId, participantId: { not: null }, isConnected: true } })
      if (!player?.participantId) throw createError({ statusCode: 403, statusMessage: 'Место не сохранено' })
      revoked = player.participantId
      await departParticipant(tx, room.id, player.participantId)
      await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: player.participantId, actorRole: 'player', eventType: 'participant.left', payload: { playerId: player.id } } })
    } else {
      if (!input.participantId || !input.token) throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных для выхода' })
      const participant = await tx.roomParticipant.findUnique({ where: { id: input.participantId } })
      if (!participant || participant.roomId !== room.id || !participant.isConnected || !verifySecret(input.token, participant.sessionTokenHash)) throw createError({ statusCode: 403, statusMessage: 'Сессия уже завершена' })
      revoked = participant.id
      await departParticipant(tx, room.id, participant.id)
      await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: participant.id, actorRole: participant.role, eventType: 'participant.left', payload: { participantId: participant.id } } })
    }
    return deleteEmptyRoom(tx, room.id)
  })
  if (revoked) revokeRoomParticipant(input.roomCode, revoked)
  if (deleted) { closeRoomPeers(input.roomCode); return null }
  return getRoomState(input.roomCode)
}
