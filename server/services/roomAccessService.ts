import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifySecret, hashSecret } from './authService'

const derive = promisify(scrypt)
export async function hashLobbyPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `${salt}:${key.toString('hex')}`
}
export async function verifyLobbyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, value] = hash.split(':')
  if (!salt || !value) return false
  const key = await derive(password, salt, 64) as Buffer
  const expected = Buffer.from(value, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// State and chat require membership, even for public rooms. The directory exposes metadata only.
export async function authorizeRoomRead(code: string, token: string) {
  const room = await prisma.room.findUnique({ where: { code } })
  if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  if (token && verifySecret(token, room.dealerSecretHash)) return { participantId: room.dealerId, role: 'dealer' }
  const participant = token ? await prisma.roomParticipant.findFirst({ where: { roomId: room.id, sessionTokenHash: hashSecret(token), isConnected: true } }) : null
  if (!participant) throw createError({ statusCode: 403, statusMessage: 'Войдите в комнату для просмотра стола' })
  if (participant.userId) {
    const user = await prisma.user.findUnique({ where: { id: participant.userId } })
    if (!user || user.blockedAt || user.deletedAt) throw createError({ statusCode: 403, message: 'Аккаунт недоступен' })
  }
  return { participantId: participant.id, role: participant.role }
}

export async function getLobbyInfo(code: string) {
  const room = await prisma.room.findUnique({ where: { code }, include: { _count: { select: { players: { where: { participantId: { not: null } } } } } } })
  if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
  return lobbyInfo(room)
}

function lobbyInfo(room: { code: string; name: string; status: string; passwordHash: string | null; settings: unknown; _count: { players: number } }) {
  const settings = room.settings as Record<string, unknown>
  const buyIn = (settings.buyIn || {}) as Record<string, unknown>
  const predictions = (settings.predictions || {}) as Record<string, unknown>
  return { code: room.code, name: room.name, status: room.status, hasPassword: Boolean(room.passwordHash), playerCount: room._count.players,
    maxPlayers: Number(settings.maxPlayers) || 8, playerPolicy: (settings.playerPolicy || 'mixed') as 'mixed' | 'accounts' | 'guests',
    allowSpectators: settings.allowSpectators !== false, allowLateJoin: Boolean(settings.allowLateJoin),
    smallBlind: Number(settings.smallBlind) || 5, bigBlind: Number(settings.bigBlind) || 10,
    buyInEnabled: buyIn.enabled === true, minBuyIn: Number(buyIn.minBuyIn) || Number(settings.startingStack) || 1000,
    maxBuyIn: Number(buyIn.maxBuyIn) || Number(settings.startingStack) || 1000,
    predictionsEnabled: predictions.enabled === true }
}

export async function listLobbies() {
  const rooms = await prisma.room.findMany({ where: { status: { in: ['lobby', 'active', 'paused'] } }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { _count: { select: { players: { where: { participantId: { not: null } } } } } } })
  return rooms.map(lobbyInfo)
}
