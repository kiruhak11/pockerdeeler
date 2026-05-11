import type { Prisma, Room as DbRoom, Player as DbPlayer, Hand as DbHand, PlayerAction as DbPlayerAction } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { generateSecret, hashSecret, verifySecret } from './authService'
import { generateRoomCode } from '../utils/roomCode'

export interface CreateRoomPayload {
  name: string
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
}

interface RoomSettings {
  startingStack: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers: number
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
}

export interface RoomState {
  room: ReturnType<typeof mapRoom>
  players: ReturnType<typeof mapPlayer>[]
  currentHand: ReturnType<typeof mapHand> | null
  actions: ReturnType<typeof mapAction>[]
  pendingActions: ReturnType<typeof mapAction>[]
}

function mapRoom(room: DbRoom) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status as 'lobby' | 'active' | 'paused' | 'finished',
    dealerId: room.dealerId ?? '',
    dealerSecretHash: room.dealerSecretHash,
    settings: room.settings as unknown as RoomSettings,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString()
  }
}

function mapPlayer(player: DbPlayer) {
  return {
    id: player.id,
    roomId: player.roomId,
    participantId: player.participantId ?? '',
    name: player.name,
    seat: player.seat,
    stack: player.stack,
    currentBet: player.currentBet,
    totalCommitted: player.totalCommitted,
    status: player.status as 'waiting' | 'active' | 'checked' | 'folded' | 'all-in' | 'winner' | 'out',
    isConnected: player.isConnected,
    createdAt: player.createdAt.toISOString(),
    updatedAt: player.updatedAt.toISOString()
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
    appliedAt: action.appliedAt?.toISOString()
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

  return {
    startingStack: payload.startingStack,
    smallBlind,
    bigBlind,
    maxPlayers: payload.maxPlayers,
    allowLateJoin: payload.allowLateJoin,
    requireDealerActionApproval: payload.requireDealerActionApproval,
    allowSpectators: payload.allowSpectators
  }
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

  const created = await prisma.$transaction(async (tx) => {
    const code = await createUniqueRoomCode(tx)

    const room = await tx.room.create({
      data: {
        code,
        name: payload.name,
        status: 'lobby',
        dealerSecretHash,
        settings: settings as unknown as Prisma.InputJsonValue
      }
    })

    const dealerParticipantFinal = await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        role: 'dealer',
        name: 'Dealer',
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

    return {
      room,
      dealerParticipant: dealerParticipantFinal
    }
  })

  const roomCode = created.room.code
  const base = appUrl.replace(/\/$/, '')

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

function parseSettings(settings: Prisma.JsonValue): RoomSettings {
  return settings as unknown as RoomSettings
}

export async function joinRoom(roomCode: string, name: string, role: 'player' | 'spectator' = 'player') {
  const token = generateSecret('player')
  const tokenHash = hashSecret(token)

  const result = await prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    const settings = parseSettings(room.settings)

    const duplicateName = await tx.roomParticipant.findFirst({
      where: {
        roomId: room.id,
        name: { equals: name, mode: 'insensitive' }
      }
    })

    if (duplicateName) {
      throw createError({ statusCode: 409, statusMessage: 'Имя уже занято' })
    }

    if (role === 'spectator' && !settings.allowSpectators) {
      throw createError({ statusCode: 403, statusMessage: 'Зрители запрещены в этой комнате' })
    }

    if (role === 'player') {
      if (room.status !== 'lobby' && !settings.allowLateJoin) {
        throw createError({ statusCode: 409, statusMessage: 'Игра уже началась, поздний вход запрещен' })
      }

      const playerCount = await tx.player.count({ where: { roomId: room.id } })
      if (playerCount >= settings.maxPlayers) {
        throw createError({ statusCode: 409, statusMessage: 'Комната заполнена' })
      }
    }

    const participant = await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        role,
        name,
        sessionTokenHash: tokenHash,
        isConnected: true
      }
    })

    let player: DbPlayer | null = null
    if (role === 'player') {
      const maxSeat = await tx.player.aggregate({
        where: { roomId: room.id },
        _max: { seat: true }
      })

      player = await tx.player.create({
        data: {
          roomId: room.id,
          participantId: participant.id,
          name,
          seat: (maxSeat._max.seat ?? 0) + 1,
          stack: settings.startingStack,
          currentBet: 0,
          totalCommitted: 0,
          status: room.status === 'lobby' ? 'waiting' : 'active',
          isConnected: true
        }
      })
    }

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: participant.id,
        actorRole: role,
        eventType: 'participant.joined',
        payload: {
          name,
          role
        }
      }
    })

    return { room, participant, player }
  })

  return {
    roomCode: result.room.code,
    playerId: result.player?.id,
    participantId: result.participant.id,
    playerSessionToken: token,
    playerUrl: role === 'player'
      ? `/room/${result.room.code}/player?playerId=${result.player?.id}`
      : `/room/${result.room.code}/table`
  }
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
  const room = await prisma.room.findUnique({ where: { code: roomCode } })
  if (!room) {
    throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  }

  const players = await prisma.player.findMany({
    where: { roomId: room.id },
    orderBy: [{ seat: 'asc' }, { createdAt: 'asc' }]
  })

  const session = await prisma.gameSession.findFirst({
    where: { roomId: room.id },
    orderBy: { createdAt: 'desc' }
  })

  const currentHand = session
    ? await prisma.hand.findFirst({
        where: {
          sessionId: session.id,
          status: { in: ['active', 'showdown'] }
        },
        orderBy: { startedAt: 'desc' }
      })
    : null

  const actions = currentHand
    ? await prisma.playerAction.findMany({
        where: { handId: currentHand.id },
        orderBy: { createdAt: 'asc' }
      })
    : []

  const pendingActions = actions.filter((action) => action.status === 'pending')

  return {
    room: mapRoom(room),
    players: players.map(mapPlayer),
    currentHand: currentHand ? mapHand(currentHand) : null,
    actions: actions.map(mapAction),
    pendingActions: pendingActions.map(mapAction)
  }
}
