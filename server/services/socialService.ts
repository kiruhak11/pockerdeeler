import type { FriendRequest as DbFriendRequest, Friendship as DbFriendship, Prisma, RoomChatMessage as DbRoomChatMessage, RoomInvite as DbRoomInvite, User as DbUser } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { hashSecret, verifySecret } from './authService'
import { getUserByToken } from './userAccountService'
import { adjustUserWallet, lockUserWallet } from './walletService'
import { randomUUID } from 'node:crypto'
import { notifyAdminTelegram } from './adminTelegramNotificationService'
import { dispatchUserTelegram } from './notificationService'
import { getPremiumAccess } from './premiumService'

const FRIEND_PENDING = 'pending'
const FRIEND_ACCEPTED = 'accepted'
const FRIEND_REJECTED = 'rejected'

const INVITE_PENDING = 'pending'
const INVITE_ACCEPTED = 'accepted'
const INVITE_DECLINED = 'declined'

function normalizeUsername(username: string) {
  return username.trim().toLowerCase()
}

function toPublicUser(user: Pick<DbUser, 'id' | 'username' | 'balance'>) {
  return {
    id: user.id,
    username: user.username,
    balance: user.balance
  }
}

function normalizeFriendPair(userIdA: string, userIdB: string) {
  return userIdA < userIdB
    ? { userAId: userIdA, userBId: userIdB }
    : { userAId: userIdB, userBId: userIdA }
}

function mapFriendship(friendship: DbFriendship & { userA: DbUser; userB: DbUser }, currentUserId: string) {
  const friend = friendship.userAId === currentUserId ? friendship.userB : friendship.userA

  return {
    friendshipId: friendship.id,
    friend: toPublicUser(friend),
    createdAt: friendship.createdAt.toISOString()
  }
}

function mapFriendRequest(request: DbFriendRequest & {
  fromUser: DbUser
  toUser: DbUser
}, currentUserId: string) {
  return {
    id: request.id,
    status: request.status as 'pending' | 'accepted' | 'rejected',
    fromUser: toPublicUser(request.fromUser),
    toUser: toPublicUser(request.toUser),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    direction: (request.toUserId === currentUserId ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing'
  }
}

function mapRoomInvite(invite: DbRoomInvite & {
  room: { code: string; name: string }
  fromUser: DbUser
  toUser: DbUser
}) {
  return {
    id: invite.id,
    roomCode: invite.room.code,
    roomName: invite.room.name,
    status: invite.status as 'pending' | 'accepted' | 'declined' | 'cancelled',
    fromUser: toPublicUser(invite.fromUser),
    toUser: toPublicUser(invite.toUser),
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString()
  }
}

function mapChatMessage(message: DbRoomChatMessage & { participant?: { role: string } | null }) {
  return {
    id: message.id,
    roomId: message.roomId,
    participantId: message.participantId ?? undefined,
    userId: message.userId ?? undefined,
    senderName: message.senderName,
    text: message.deletedAt ? '' : message.text,
    clientRequestId: message.clientRequestId ?? undefined,
    senderRole: message.participant?.role as 'dealer' | 'player' | 'spectator' | undefined,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString()
  }
}

export async function listFriends(token: string) {
  const user = await getUserByToken(token)

  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userAId: user.id },
        { userBId: user.id }
      ]
    },
    include: {
      userA: true,
      userB: true
    },
    orderBy: { createdAt: 'desc' }
  })

  return {
    friends: friendships.map((item) => mapFriendship(item, user.id))
  }
}

export async function listFriendRequests(token: string) {
  const user = await getUserByToken(token)

  const requests = await prisma.friendRequest.findMany({
    where: {
      OR: [
        { fromUserId: user.id },
        { toUserId: user.id }
      ]
    },
    include: {
      fromUser: true,
      toUser: true
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 200
  })

  return {
    requests: requests.map((item) => mapFriendRequest(item, user.id))
  }
}

export async function deleteFriend(input: { token: string; friendshipId: string }) {
  const user = await getUserByToken(input.token)
  const deleted = await prisma.friendship.deleteMany({
    where: { id: input.friendshipId, OR: [{ userAId: user.id }, { userBId: user.id }] }
  })
  // deleteMany is intentionally scoped to either endpoint of the pair, so a
  // forged friendship id cannot delete somebody else's relationship.
  if (!deleted.count) return { success: true, duplicate: true }
  return { success: true }
}

export async function transferToFriend(input: { token: string; friendUserId: string; amount: number; requestId: string }) {
  const sender = await getUserByToken(input.token)
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 1_000_000) {
    throw createError({ statusCode: 400, statusMessage: 'Сумма перевода должна быть от 1 до 1 000 000 фишек' })
  }
  if (sender.id === input.friendUserId) throw createError({ statusCode: 400, statusMessage: 'Нельзя переводить фишки самому себе' })

  const result = await prisma.$transaction(async tx => {
    const pair = normalizeFriendPair(sender.id, input.friendUserId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`friend-transfer:${pair.userAId}:${pair.userBId}`}, 0))`
    const friendship = await tx.friendship.findUnique({ where: { userAId_userBId: pair } })
    if (!friendship) throw createError({ statusCode: 403, statusMessage: 'Переводы доступны только друзьям' })
    const target = await tx.user.findUnique({ where: { id: input.friendUserId }, select: { id: true, username: true, deletedAt: true } })
    if (!target || target.deletedAt) throw createError({ statusCode: 404, statusMessage: 'Пользователь не найден' })

    if (sender.id < target.id) {
      await lockUserWallet(tx, sender.id)
      await lockUserWallet(tx, target.id)
    } else {
      await lockUserWallet(tx, target.id)
      await lockUserWallet(tx, sender.id)
    }
    const transferId = randomUUID()
    await adjustUserWallet(tx, { userId: sender.id, delta: -BigInt(input.amount), entryType: 'FRIEND_TRANSFER_DEBIT', transferId, idempotencyKey: `friend-transfer:debit:${input.requestId}`, metadata: { friendUserId: target.id, friendUsername: target.username } })
    await adjustUserWallet(tx, { userId: target.id, delta: BigInt(input.amount), entryType: 'FRIEND_TRANSFER_CREDIT', transferId, idempotencyKey: `friend-transfer:credit:${input.requestId}`, metadata: { senderUserId: sender.id, senderUsername: sender.username } })
    const senderWallet = await tx.userWallet.findUniqueOrThrow({ where: { userId: sender.id }, select: { balance: true } })
    const result = { success: true, friend: { id: target.id, username: target.username }, amount: input.amount, balance: Number(senderWallet.balance) }
    return result
  })
  // Telegram is an external network call and must not hold the wallet
  // transaction open. A slow Telegram API previously caused a successful
  // transfer to roll back with Prisma's 5s transaction timeout.
  dispatchUserTelegram(result.friend.id, 'purchases', `Вам перевели ${input.amount.toLocaleString('ru-RU')} фишек от ${sender.username}.`)
  await notifyAdminTelegram('users', `Перевод виртуальных фишек: ${sender.username} → ${result.friend.username}, сумма ${input.amount.toLocaleString('ru-RU')}.`)
  return result
}

export async function sendFriendRequest(input: { token: string; username: string }) {
  const user = await getUserByToken(input.token)
  const targetUsername = normalizeUsername(input.username)

  if (targetUsername.length < 3) {
    throw createError({ statusCode: 400, statusMessage: 'Введите корректный логин друга' })
  }

  const targetUser = await prisma.user.findUnique({ where: { username: targetUsername } })
  if (!targetUser) {
    throw createError({ statusCode: 404, statusMessage: 'Пользователь не найден' })
  }

  if (targetUser.id === user.id) {
    throw createError({ statusCode: 400, statusMessage: 'Нельзя добавить себя в друзья' })
  }

  const friendshipPair = normalizeFriendPair(user.id, targetUser.id)
  const existingFriendship = await prisma.friendship.findUnique({
    where: {
      userAId_userBId: friendshipPair
    }
  })

  if (existingFriendship) {
    throw createError({ statusCode: 409, statusMessage: 'Вы уже друзья' })
  }

  const reverseRequest = await prisma.friendRequest.findUnique({
    where: {
      fromUserId_toUserId: {
        fromUserId: targetUser.id,
        toUserId: user.id
      }
    }
  })

  if (reverseRequest?.status === FRIEND_PENDING) {
    throw createError({ statusCode: 409, statusMessage: 'У вас уже есть входящая заявка от этого пользователя' })
  }

  const request = await prisma.friendRequest.upsert({
    where: {
      fromUserId_toUserId: {
        fromUserId: user.id,
        toUserId: targetUser.id
      }
    },
    update: {
      status: FRIEND_PENDING,
      updatedAt: new Date()
    },
    create: {
      fromUserId: user.id,
      toUserId: targetUser.id,
      status: FRIEND_PENDING
    },
    include: {
      fromUser: true,
      toUser: true
    }
  })

  dispatchUserTelegram(targetUser.id, 'friends', `${user.username} отправил(а) вам заявку в друзья.`)
  return {
    request: mapFriendRequest(request, user.id)
  }
}

export async function respondFriendRequest(input: {
  token: string
  requestId: string
  decision: 'accept' | 'reject'
}) {
  const user = await getUserByToken(input.token)

  const request = await prisma.friendRequest.findUnique({
    where: { id: input.requestId },
    include: {
      fromUser: true,
      toUser: true
    }
  })

  if (!request) {
    throw createError({ statusCode: 404, statusMessage: 'Заявка не найдена' })
  }

  if (request.toUserId !== user.id) {
    throw createError({ statusCode: 403, statusMessage: 'Нельзя управлять чужой заявкой' })
  }

  if (request.status !== FRIEND_PENDING) {
    throw createError({ statusCode: 409, statusMessage: 'Заявка уже обработана' })
  }

  const nextStatus = input.decision === 'accept' ? FRIEND_ACCEPTED : FRIEND_REJECTED

  const updatedRequest = await prisma.$transaction(async (tx) => {
    const updated = await tx.friendRequest.update({
      where: { id: request.id },
      data: {
        status: nextStatus,
        updatedAt: new Date()
      },
      include: {
        fromUser: true,
        toUser: true
      }
    })

    if (nextStatus === FRIEND_ACCEPTED) {
      const pair = normalizeFriendPair(request.fromUserId, request.toUserId)

      await tx.friendship.upsert({
        where: {
          userAId_userBId: pair
        },
        update: {},
        create: {
          userAId: pair.userAId,
          userBId: pair.userBId
        }
      })

      await tx.friendRequest.updateMany({
        where: {
          fromUserId: request.toUserId,
          toUserId: request.fromUserId,
          status: FRIEND_PENDING
        },
        data: {
          status: FRIEND_ACCEPTED,
          updatedAt: new Date()
        }
      })
    }

    return updated
  })

  if (nextStatus === FRIEND_ACCEPTED) {
    dispatchUserTelegram(request.fromUserId, 'friends', `${user.username} принял(а) вашу заявку в друзья.`)
  }
  return {
    request: mapFriendRequest(updatedRequest, user.id)
  }
}

export async function inviteFriendToRoom(input: {
  token: string
  roomCode: string
  friendUserId: string
}) {
  const user = await getUserByToken(input.token)

  const invite = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${input.roomCode} FOR UPDATE`

    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    if (room.status !== 'lobby') {
      throw createError({ statusCode: 409, statusMessage: 'Приглашения доступны только в лобби' })
    }

    if (input.friendUserId === user.id) {
      throw createError({ statusCode: 400, statusMessage: 'Нельзя отправить приглашение самому себе' })
    }

    const friend = await tx.user.findUnique({ where: { id: input.friendUserId } })
    if (!friend) {
      throw createError({ statusCode: 404, statusMessage: 'Друг не найден' })
    }

    const friendPair = normalizeFriendPair(user.id, friend.id)
    const friendship = await tx.friendship.findUnique({
      where: {
        userAId_userBId: friendPair
      }
    })

    if (!friendship) {
      throw createError({ statusCode: 403, statusMessage: 'Можно приглашать только пользователей из друзей' })
    }

    const inviterParticipant = await tx.roomParticipant.findFirst({
      where: {
        roomId: room.id,
        userId: user.id,
        isConnected: true,
        role: { in: ['dealer', 'player'] }
      }
    })

    if (!inviterParticipant) {
      throw createError({ statusCode: 403, statusMessage: 'Приглашать в комнату может только подключенный участник' })
    }

    const alreadyInRoom = await tx.roomParticipant.findFirst({
      where: {
        roomId: room.id,
        userId: friend.id,
        role: 'player',
        isConnected: true
      }
    })

    if (alreadyInRoom) {
      throw createError({ statusCode: 409, statusMessage: 'Пользователь уже находится в комнате' })
    }

    const savedInvite = await tx.roomInvite.upsert({
      where: {
        roomId_fromUserId_toUserId: {
          roomId: room.id,
          fromUserId: user.id,
          toUserId: friend.id
        }
      },
      update: {
        status: INVITE_PENDING,
        updatedAt: new Date()
      },
      create: {
        roomId: room.id,
        fromUserId: user.id,
        toUserId: friend.id,
        status: INVITE_PENDING
      },
      include: {
        room: {
          select: {
            code: true,
            name: true
          }
        },
        fromUser: true,
        toUser: true
      }
    })

    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: inviterParticipant.id,
        actorRole: inviterParticipant.role as 'dealer' | 'player' | 'spectator',
        eventType: 'room.invite.sent',
        payload: {
          toUserId: friend.id,
          inviteId: savedInvite.id
        } as Prisma.InputJsonValue
      }
    })

    return savedInvite
  })

  dispatchUserTelegram(invite.toUserId, 'games', `Вас приглашают в игру «${invite.room.name}». Перейти: ${process.env.NUXT_PUBLIC_APP_URL || ''}/room/${invite.room.code}/join`)
  return {
    invite: mapRoomInvite(invite)
  }
}

export async function listRoomInvites(token: string) {
  const user = await getUserByToken(token)

  const invites = await prisma.roomInvite.findMany({
    where: {
      toUserId: user.id
    },
    include: {
      room: {
        select: {
          code: true,
          name: true
        }
      },
      fromUser: true,
      toUser: true
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 100
  })

  return {
    invites: invites.map(mapRoomInvite)
  }
}

export async function respondRoomInvite(input: {
  token: string
  inviteId: string
  decision: 'accept' | 'decline'
}) {
  const user = await getUserByToken(input.token)

  const result = await prisma.$transaction(async (tx) => {
    const invite = await tx.roomInvite.findUnique({
      where: { id: input.inviteId },
      include: {
        room: {
          select: {
            id: true,
            code: true,
            name: true,
            status: true
          }
        },
        fromUser: true,
        toUser: true
      }
    })

    if (!invite) {
      throw createError({ statusCode: 404, statusMessage: 'Приглашение не найдено' })
    }

    if (invite.toUserId !== user.id) {
      throw createError({ statusCode: 403, statusMessage: 'Нельзя управлять чужим приглашением' })
    }

    if (invite.status !== INVITE_PENDING) {
      throw createError({ statusCode: 409, statusMessage: 'Приглашение уже обработано' })
    }

    if (input.decision === 'accept' && invite.room.status !== 'lobby') {
      throw createError({ statusCode: 409, statusMessage: 'Лобби уже закрыто для приглашения' })
    }

    const nextStatus = input.decision === 'accept' ? INVITE_ACCEPTED : INVITE_DECLINED
    const updatedInvite = await tx.roomInvite.update({
      where: { id: invite.id },
      data: {
        status: nextStatus,
        updatedAt: new Date()
      },
      include: {
        room: {
          select: {
            id: true,
            code: true,
            name: true,
            status: true
          }
        },
        fromUser: true,
        toUser: true
      }
    })

    const actorParticipant = await tx.roomParticipant.findFirst({
      where: {
        roomId: invite.room.id,
        userId: user.id
      },
      orderBy: { joinedAt: 'desc' }
    })

    await tx.auditLog.create({
      data: {
        roomId: invite.room.id,
        actorParticipantId: actorParticipant?.id ?? null,
        actorRole: (actorParticipant?.role || 'player') as 'dealer' | 'player' | 'spectator',
        eventType: `room.invite.${nextStatus}`,
        payload: {
          inviteId: updatedInvite.id,
          fromUserId: updatedInvite.fromUserId,
          toUserId: updatedInvite.toUserId
        } as Prisma.InputJsonValue
      }
    })

    return updatedInvite
  })

  if (input.decision === 'accept') dispatchUserTelegram(result.fromUserId, 'games', `${user.username} принял(а) приглашение в игру «${result.room.name}».`)
  return {
    invite: mapRoomInvite(result),
    joinUrl: input.decision === 'accept' ? `/room/${result.room.code}/join` : null
  }
}

interface ChatCredentials {
  roomCode: string
  token?: string
  participantId?: string
  dealerSecret?: string
}

// Keep authorization inside the transaction that reads/writes chat. isConnected is
// currently the membership-revocation flag, not websocket presence in this app.
async function authorizeChat(tx: Prisma.TransactionClient, input: ChatCredentials) {
  const room = await tx.room.findUnique({ where: { code: input.roomCode } })
  if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  const secret = input.dealerSecret || input.token || ''
  const dealer = Boolean(secret && verifySecret(secret, room.dealerSecretHash))
  const participant = dealer && room.dealerId
    ? await tx.roomParticipant.findUnique({ where: { id: room.dealerId } })
    : secret ? await tx.roomParticipant.findFirst({ where: {
        roomId: room.id, sessionTokenHash: hashSecret(secret), isConnected: true,
        ...(input.participantId ? { id: input.participantId } : {})
      } }) : null
  if (!participant || participant.roomId !== room.id || !participant.isConnected
      || !['dealer', 'player', 'spectator'].includes(participant.role)
      || (input.dealerSecret && !dealer)) {
    throw createError({ statusCode: 403, statusMessage: 'Войдите в комнату для доступа к чату' })
  }
  return { room, participant }
}

async function assertRoomChatPremium(tx: Prisma.TransactionClient, userId: string | null) {
  if (!userId) throw createError({ statusCode: 403, statusMessage: 'Чат доступен пользователям с Premium Lite' })
  const access = await getPremiumAccess(userId, tx)
  if (!access.features.includes('ROOM_CHAT')) throw createError({ statusCode: 403, statusMessage: 'Чат доступен пользователям с Premium Lite' })
}

export async function listRoomChatMessages(input: ChatCredentials & { before?: string; after?: string; limit?: number; check?: string[] }) {
  const limit = input.limit ?? 40
  if (!Number.isInteger(limit) || limit < 1 || limit > 60 || (input.before && input.after) || (input.check && input.check.length > 60)) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректная страница чата' })
  }
  return prisma.$transaction(async (tx) => {
    const { room, participant } = await authorizeChat(tx, input)
    await assertRoomChatPremium(tx, participant.userId)
    if (input.check) {
      const deleted = await tx.roomChatMessage.findMany({
        where: { roomId: room.id, id: { in: input.check }, deletedAt: { not: null } }, select: { id: true }, take: 60
      })
      return { messages: [], nextCursor: null, revision: room.revision, deletedIds: deleted.map(message => message.id) }
    }
    const cursorId = input.before || input.after
    // Resolve even a deleted cursor so moderation cannot break pagination.
    const cursor = cursorId ? await tx.roomChatMessage.findFirst({ where: { id: cursorId, roomId: room.id } }) : null
    if (cursorId && !cursor) throw createError({ statusCode: 400, statusMessage: 'Курсор чата устарел' })
    const direction = input.after ? 'asc' : 'desc'
    const bound = input.after ? 'gt' : 'lt'
    const rows = await tx.roomChatMessage.findMany({
      where: {
        roomId: room.id, deletedAt: null,
        ...(cursor ? { OR: [
          { createdAt: { [bound]: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { [bound]: cursor.id } }
        ] } : {})
      },
      orderBy: [{ createdAt: direction }, { id: direction }], take: limit + 1,
      include: { participant: { select: { role: true } } }
    })
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const nextCursor = hasMore ? page.at(-1)!.id : null
    return { messages: (input.after ? page : page.reverse()).map(mapChatMessage), nextCursor, revision: room.revision }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function sendRoomChatMessage(input: ChatCredentials & { message: string; clientRequestId: string }) {
  const text = input.message.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]+/gu, ' ').trim()
  if (!text || text.length > 300 || /[\u0000-\u0008\u000E-\u001F\u007F]/u.test(text)) {
    throw createError({ statusCode: 400, statusMessage: 'Введите текст от 1 до 300 символов без управляющих знаков' })
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(input.clientRequestId)) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректный ключ сообщения' })
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${input.roomCode} FOR UPDATE`
    const { room, participant } = await authorizeChat(tx, input)
    await assertRoomChatPremium(tx, participant.userId)
    const prior = await tx.roomChatMessage.findUnique({ where: { roomId_participantId_clientRequestId: {
      roomId: room.id, participantId: participant.id, clientRequestId: input.clientRequestId
    } }, include: { participant: { select: { role: true } } } })
    if (prior) {
      if (prior.text !== text) throw createError({ statusCode: 409, statusMessage: 'Ключ уже использован для другого сообщения' })
      return { message: prior, duplicate: true }
    }
    if (room.status === 'finished') throw createError({ statusCode: 409, statusMessage: 'Комната закрыта для сообщений' })
    // Persisted flood control is serialized by the room lock across workers.
    const recent = await tx.roomChatMessage.findMany({ where: {
      roomId: room.id, participantId: participant.id, createdAt: { gte: new Date(Date.now() - 60_000) }
    }, orderBy: { createdAt: 'desc' }, take: 20 })
    if (recent.length >= 20 || (recent[0] && Date.now() - recent[0].createdAt.getTime() < 1000)) {
      throw createError({ statusCode: 429, statusMessage: 'Слишком часто. Подождите перед отправкой' })
    }
    const message = await tx.roomChatMessage.create({ data: {
      roomId: room.id, participantId: participant.id, userId: participant.userId,
      senderName: participant.name, text, clientRequestId: input.clientRequestId
    }, include: { participant: { select: { role: true } } } })
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
    return { message, duplicate: false }
  })
  return { message: mapChatMessage(result.message), duplicate: result.duplicate }
}

export async function moderateRoomChatMessage(actorId: string, input: { id: string; reason: string; requestId: string }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-chat:${input.requestId}`}, 0))`
    const target = await tx.roomChatMessage.findUnique({ where: { id: input.id }, include: { room: { select: { code: true } } } })
    if (!target) throw createError({ statusCode: 404, message: 'Сообщение не найдено' })
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${target.roomId}::uuid FOR UPDATE`
    const actor = await tx.user.findUnique({ where: { id: actorId } })
    if (!actor || !['ADMIN', 'SUPERADMIN'].includes(actor.role) || !actor.phoneVerifiedAt || actor.mustChangePassword || actor.blockedAt || actor.deletedAt) {
      throw createError({ statusCode: 403, message: 'Права администратора отозваны' })
    }
    const prior = await tx.adminAudit.findUnique({ where: { requestId: input.requestId } })
    if (prior) {
      if (prior.actorId !== actorId || prior.action !== 'chat.delete' || prior.entityId !== input.id || prior.reason !== input.reason) {
        throw createError({ statusCode: 409, message: 'Ключ запроса уже использован' })
      }
      return { roomCode: target.room.code, duplicate: true }
    }
    const changed = await tx.roomChatMessage.updateMany({ where: { id: target.id, deletedAt: null }, data: { deletedAt: new Date(), deletionReason: input.reason } })
    await tx.adminAudit.create({ data: {
      actorId, action: 'chat.delete', entityId: target.id, reason: input.reason, requestId: input.requestId,
      data: { roomId: target.roomId, roomCode: target.room.code, participantId: target.participantId, alreadyDeleted: changed.count === 0 }
    } })
    if (changed.count) await tx.room.update({ where: { id: target.roomId }, data: { revision: { increment: 1 } } })
    return { roomCode: target.room.code, duplicate: false }
  })
}
