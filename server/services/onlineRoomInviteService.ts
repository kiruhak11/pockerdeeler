import { createError } from 'h3'
import { prisma } from '../db/client'
import { queueTelegramUserEvent } from './notificationService'
import { getUserByToken } from './userAccountService'
import { OnlineRoomRuntimeStore } from './onlineRoomRuntimeStore'

const INVITE_COOLDOWN_MS = 10 * 60 * 1000

function friendPair(userAId: string, userBId: string) {
  return userAId < userBId ? { userAId, userBId } : { userAId: userBId, userBId: userAId }
}

function publicAppOrigin(): string {
  const configured = process.env.NUXT_PUBLIC_APP_URL
  if (!configured) return ''
  try {
    const url = new URL(configured)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

export async function inviteFriendToOnlineRoom(input: {
  token: string
  roomCode: string
  friendUserId: string
}, dependencies: { runtime?: OnlineRoomRuntimeStore } = {}) {
  const sender = await getUserByToken(input.token)
  const metadataHint = await prisma.onlineRoom.findUnique({
    where: { roomCode: input.roomCode },
    select: { id: true }
  })
  if (!metadataHint) throw createError({ statusCode: 404, message: 'Онлайн-комната не найдена.' })

  const runtime = dependencies.runtime ?? new OnlineRoomRuntimeStore()
  try {
    const record = await runtime.get(metadataHint.id)
    if (!record || record.state.roomId !== metadataHint.id || record.state.roomCode !== input.roomCode || record.state.status === 'CLOSED') {
      throw createError({ statusCode: 409, message: 'Онлайн-комната уже недоступна.' })
    }
    if (!record.state.pokerTable.players.some(player => player.playerId === sender.id)) {
      throw createError({ statusCode: 403, message: 'Приглашать может только игрок за этим столом.' })
    }

    const now = Date.now()
    const cooldownStart = new Date(now - INVITE_COOLDOWN_MS)
    const eventPrefix = `online-room-invite:${metadataHint.id}:${sender.id}:${input.friendUserId}:`
    const eventKey = `${eventPrefix}${Math.floor(now / INVITE_COOLDOWN_MS)}`
    const roomUrl = `${publicAppOrigin()}/online/${encodeURIComponent(record.state.roomCode)}?join=1`

    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "online_rooms" WHERE id = ${metadataHint.id}::uuid FOR UPDATE`
      const room = await tx.onlineRoom.findUnique({ where: { id: metadataHint.id } })
      if (!room || room.roomCode !== input.roomCode || room.status === 'CLOSED' || room.visibility !== record.state.visibility) {
        throw createError({ statusCode: 409, message: 'Онлайн-комната уже недоступна.' })
      }

      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`online-room-invite:${room.id}:${sender.id}:${input.friendUserId}`}, 0)) IS NULL AS locked`
      if (input.friendUserId === sender.id) throw createError({ statusCode: 400, message: 'Нельзя пригласить самого себя.' })
      const friend = await tx.user.findUnique({
        where: { id: input.friendUserId },
        select: { id: true, username: true, deletedAt: true, blockedAt: true, isBot: true }
      })
      if (!friend || friend.deletedAt || friend.blockedAt || friend.isBot) {
        throw createError({ statusCode: 404, message: 'Друг не найден или недоступен.' })
      }

      const friendship = await tx.friendship.findUnique({ where: { userAId_userBId: friendPair(sender.id, friend.id) }, select: { id: true } })
      if (!friendship) throw createError({ statusCode: 403, message: 'Приглашать можно только друзей.' })

      const recentInvite = await tx.telegramUserEvent.findFirst({
        where: { eventKey: { startsWith: eventPrefix }, createdAt: { gte: cooldownStart } },
        select: { id: true }
      })
      if (recentInvite) return { sent: true, duplicate: true }

      const created = await queueTelegramUserEvent(tx, {
        userId: friend.id,
        category: 'games',
        eventKey,
        text: `${sender.username} приглашает вас за ONLINE-стол ${room.roomCode}. Перейти к столу: ${roomUrl}`
      })
      return { sent: true, duplicate: !created }
    })
  } finally {
    if (!dependencies.runtime) await runtime.disconnect().catch(() => undefined)
  }
}
