import type { Player as DbPlayer, Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifySecret } from './authService'
import { getRoomState } from './roomService'
import {
  applyPlayerAction,
  distributePot,
  sumCommitted,
  getAvailableActions,
  assertChipConservation
} from '../../app/utils/pokerCalculations'
import type { Player as CalcPlayer } from '../../app/types/game'

interface DealerAuth {
  roomCode: string
  dealerSecret: string
}

function parseSettings(settings: Prisma.JsonValue): {
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
} {
  return settings as {
    startingStack: number
    smallBlind?: number
    bigBlind?: number
    maxPlayers: number
    allowLateJoin: boolean
    requireDealerActionApproval: boolean
    allowSpectators: boolean
  }
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

  await tx.$queryRaw`SELECT id FROM "game_sessions" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "players" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "hands" WHERE "room_id" = CAST(${room.id} AS uuid) FOR UPDATE`

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

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    if (players.length < 2) {
      throw createError({ statusCode: 409, statusMessage: 'Нужно минимум 2 игрока' })
    }

    for (const player of players) {
      player.currentBet = 0
      player.totalCommitted = 0
      player.status = player.stack > 0 ? 'active' : 'out'
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

export async function startHandByDealer({ roomCode, dealerSecret }: DealerAuth) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, roomCode)
    ensureDealerSecretOrThrow(room.dealerSecretHash, dealerSecret)

    const settings = parseSettings(room.settings)

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
      player.status = player.stack > 0 ? 'active' : 'out'
    }

    const activePlayers = players.filter((player) => player.stack > 0)
    const blindPositions = getBlindPositions(activePlayers, session.dealerButtonPlayerId)

    const smallBlind = settings.smallBlind ?? 5
    const bigBlind = settings.bigBlind ?? Math.max(smallBlind * 2, 10)

    applyBlind(blindPositions.smallBlind, smallBlind)
    applyBlind(blindPositions.bigBlind, bigBlind)

    const pot = sumCommitted(toCalcPlayers(players))
    const currentBet = Math.max(...players.map((player) => player.currentBet), 0)

    const bigBlindIndex = activePlayers.findIndex((player) => player.id === blindPositions.bigBlind.id)
    const firstToAct = activePlayers[nextIndex(bigBlindIndex, activePlayers.length)]

    await savePlayers(tx, players)

    const handNumber = session.handNumber + 1

    const hand = await tx.hand.create({
      data: {
        roomId: room.id,
        sessionId: session.id,
        handNumber,
        status: 'active',
        pot,
        currentBet
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        handNumber,
        pot,
        currentBet,
        currentPlayerId: firstToAct?.id ?? null,
        dealerButtonPlayerId: blindPositions.dealer.id,
        smallBlindPlayerId: blindPositions.smallBlind.id,
        bigBlindPlayerId: blindPositions.bigBlind.id,
        updatedAt: new Date()
      }
    })

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
      players: toCalcPlayers(players),
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

    if (session.currentPlayerId && session.currentPlayerId !== player.id) {
      throw createError({ statusCode: 409, statusMessage: 'Сейчас ход другого игрока' })
    }

    const settings = parseSettings(room.settings)

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
        return {
          success: true,
          action: existingPending
        }
      }

      const pending = await tx.playerAction.create({
        data: {
          roomId: room.id,
          handId: hand.id,
          playerId: player.id,
          type: input.type,
          amount: input.amount,
          status: 'pending',
          clientRequestId: input.clientRequestId
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
        status: hand.status
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
        appliedAt: new Date()
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

    const nextPlayer = getNextPlayerBySeat(players, result.players, player.id)

    await tx.hand.update({
      where: { id: hand.id },
      data: {
        pot: result.pot,
        currentBet: result.currentBet
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        pot: result.pot,
        currentBet: result.currentBet,
        currentPlayerId: nextPlayer?.id ?? null,
        updatedAt: new Date()
      }
    })

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

    if (session.currentPlayerId && session.currentPlayerId !== pending.playerId) {
      throw createError({ statusCode: 409, statusMessage: 'Ожидающее действие уже не актуально: сменился ход' })
    }

    const players = await tx.player.findMany({
      where: { roomId: room.id },
      orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
    })

    const calcPlayers = toCalcPlayers(players)

    await createSnapshot(tx, room.id, hand.id, 'before_action', {
      players: calcPlayers,
      hand: {
        pot: hand.pot,
        currentBet: hand.currentBet,
        status: hand.status
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

    const nextPlayer = getNextPlayerBySeat(players, result.players, pending.playerId)

    await tx.hand.update({
      where: { id: hand.id },
      data: {
        pot: result.pot,
        currentBet: result.currentBet
      }
    })

    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        pot: result.pot,
        currentBet: result.currentBet,
        currentPlayerId: nextPlayer?.id ?? null,
        updatedAt: new Date()
      }
    })

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

export async function distributePotByDealer(input: {
  roomCode: string
  dealerSecret: string
  winners: string[]
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
        status: hand.status
      },
      session: {
        pot: session.pot,
        currentBet: session.currentBet,
        status: session.status,
        currentPlayerId: session.currentPlayerId
      }
    })

    const distribution = distributePot(calcPlayers, input.winners)
    assertChipConservation(distribution.players, totalBefore)

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

    await tx.hand.update({
      where: { id: hand.id },
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
        pot: 0,
        currentBet: 0,
        currentPlayerId: null,
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

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'pot.distributed',
        payload: {
          handId: hand.id,
          winners: distribution.result.winners,
          returned: distribution.result.returned
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
      where: { roomId: room.id },
      orderBy: { createdAt: 'desc' }
    })

    if (!snapshot) {
      throw createError({ statusCode: 409, statusMessage: 'Нет snapshot для отката' })
    }

    const data = snapshot.data as {
      players?: CalcPlayer[]
      hand?: {
        pot: number
        currentBet: number
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
            currentPlayerId: data.session?.currentPlayerId ?? session.currentPlayerId,
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
        await tx.playerAction.delete({
          where: { id: lastAppliedAction.id }
        })
      }
    }

    if (snapshot.snapshotType === 'before_distribution') {
      await tx.handResult.deleteMany({
        where: { handId: snapshot.handId }
      })
    }

    await tx.gameSnapshot.delete({ where: { id: snapshot.id } })

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

export async function leaveRoom(input: {
  roomCode: string
  participantId?: string
  playerId?: string
  token?: string
  dealerSecret?: string
}) {
  await prisma.$transaction(async (tx) => {
    const room = await lockRoomForUpdate(tx, input.roomCode)

    if (input.dealerSecret) {
      ensureDealerSecretOrThrow(room.dealerSecretHash, input.dealerSecret)
      return
    }

    if (!input.participantId || !input.token) {
      throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных для выхода' })
    }

    const participant = await tx.roomParticipant.findUnique({ where: { id: input.participantId } })
    if (!participant || participant.roomId !== room.id || !verifySecret(input.token, participant.sessionTokenHash)) {
      throw createError({ statusCode: 403, statusMessage: 'Неверные данные сессии' })
    }

    await tx.roomParticipant.update({
      where: { id: participant.id },
      data: {
        isConnected: false,
        lastSeenAt: new Date()
      }
    })

    if (input.playerId) {
      await tx.player.updateMany({
        where: {
          id: input.playerId,
          participantId: participant.id
        },
        data: {
          isConnected: false,
          updatedAt: new Date()
        }
      })
    }

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: participant.id,
        actorRole: participant.role as 'player' | 'spectator' | 'dealer',
        eventType: 'participant.left',
        payload: {
          participantId: participant.id
        }
      }
    })
  })

  return getRoomState(input.roomCode)
}
