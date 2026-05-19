import type { FriendRequest as DbFriendRequest, Friendship as DbFriendship, Prisma, RoomChatMessage as DbRoomChatMessage, RoomInvite as DbRoomInvite, User as DbUser } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifySecret } from './authService'
import { getUserByToken } from './userAccountService'

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

  return {
    invite: mapRoomInvite(result),
    joinUrl: input.decision === 'accept' ? `/room/${result.room.code}/join` : null
  }
}

export async function sendRoomChatMessage(input: {
  roomCode: string
  message: string
  participantId?: string
  token?: string
  dealerSecret?: string
}) {
  const text = input.message.trim()
  if (!text) {
    throw createError({ statusCode: 400, statusMessage: 'Сообщение пустое' })
  }

  if (text.length > 300) {
    throw createError({ statusCode: 400, statusMessage: 'Сообщение не должно быть длиннее 300 символов' })
  }

  const message = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE "code" = ${input.roomCode} FOR UPDATE`

    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) {
      throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    }

    if (input.dealerSecret) {
      if (!verifySecret(input.dealerSecret, room.dealerSecretHash)) {
        throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
      }

      const dealerParticipant = room.dealerId
        ? await tx.roomParticipant.findUnique({ where: { id: room.dealerId } })
        : null

      return tx.roomChatMessage.create({
        data: {
          roomId: room.id,
          participantId: dealerParticipant?.id ?? null,
          userId: dealerParticipant?.userId ?? null,
          senderName: dealerParticipant?.name || 'Дилер',
          text
        }
      })
    }

    if (!input.participantId || !input.token) {
      throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных для отправки сообщения' })
    }

    const participant = await tx.roomParticipant.findUnique({
      where: { id: input.participantId }
    })

    if (!participant || participant.roomId !== room.id) {
      throw createError({ statusCode: 404, statusMessage: 'Участник комнаты не найден' })
    }

    if (!verifySecret(input.token, participant.sessionTokenHash)) {
      throw createError({ statusCode: 403, statusMessage: 'Неверный токен сессии' })
    }

    if (!participant.isConnected) {
      throw createError({ statusCode: 409, statusMessage: 'Сессия участника неактивна' })
    }

    return tx.roomChatMessage.create({
      data: {
        roomId: room.id,
        participantId: participant.id,
        userId: participant.userId,
        senderName: participant.name,
        text
      }
    })
  })

  return {
    message: mapChatMessage(message)
  }
}
