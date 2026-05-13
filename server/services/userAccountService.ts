import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { prisma } from '../db/client'

const DEFAULT_BALANCE = 5000
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30

function authSecret(): string {
  return process.env.JWT_SECRET || process.env.ROOM_SECRET_PEPPER || 'local-auth-secret'
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

function hashPassword(password: string, salt?: string): string {
  const localSalt = salt || randomBytes(16).toString('hex')
  const pepper = process.env.ROOM_SECRET_PEPPER || 'dev-pepper'
  const derived = scryptSync(`${password}:${pepper}`, localSalt, 64).toString('hex')
  return `${localSalt}:${derived}`
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, current] = storedHash.split(':')
  if (!salt || !current) {
    return false
  }

  const candidate = hashPassword(password, salt).split(':')[1] || ''
  const left = Buffer.from(current)
  const right = Buffer.from(candidate)
  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}

function sign(payload: string): string {
  return createHmac('sha256', authSecret()).update(payload).digest('base64url')
}

export function issueUserAuthToken(userId: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS
  const nonce = randomBytes(8).toString('hex')
  const payload = `${userId}.${expiresAt}.${nonce}`
  const signature = sign(payload)
  return `${payload}.${signature}`
}

export function verifyUserAuthToken(token: string): { userId: string } | null {
  if (!token) {
    return null
  }

  const parts = token.split('.')
  if (parts.length < 4) {
    return null
  }

  const signature = parts.pop() as string
  const payload = parts.join('.')
  const expected = sign(payload)
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)

  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null
  }

  const [userId, expiresAtRaw] = parts
  const expiresAt = Number(expiresAtRaw)
  if (!userId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return null
  }

  return { userId }
}

function toPublicUser(user: { id: string; username: string; balance: number }) {
  return {
    id: user.id,
    username: user.username,
    balance: user.balance
  }
}

export async function registerUser(input: { username: string; password: string }) {
  const username = normalizeUsername(input.username)
  const password = input.password

  if (username.length < 3 || username.length > 32) {
    throw createError({ statusCode: 400, statusMessage: 'Логин должен быть длиной от 3 до 32 символов' })
  }

  if (password.length < 6 || password.length > 128) {
    throw createError({ statusCode: 400, statusMessage: 'Пароль должен быть длиной от 6 до 128 символов' })
  }

  const exists = await prisma.user.findUnique({ where: { username } })
  if (exists) {
    throw createError({ statusCode: 409, statusMessage: 'Пользователь с таким логином уже существует' })
  }

  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: hashPassword(password),
      balance: DEFAULT_BALANCE
    }
  })

  return {
    user: toPublicUser(user),
    token: issueUserAuthToken(user.id)
  }
}

export async function loginUser(input: { username: string; password: string }) {
  const username = normalizeUsername(input.username)
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw createError({ statusCode: 401, statusMessage: 'Неверный логин или пароль' })
  }

  return {
    user: toPublicUser(user),
    token: issueUserAuthToken(user.id)
  }
}

export async function getUserByToken(token: string) {
  const verified = verifyUserAuthToken(token)
  if (!verified) {
    throw createError({ statusCode: 401, statusMessage: 'Невалидный токен аккаунта' })
  }

  const user = await prisma.user.findUnique({ where: { id: verified.userId } })
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'Пользователь не найден' })
  }

  return user
}

export async function getUserProfile(token: string) {
  const user = await getUserByToken(token)
  return toPublicUser(user)
}

export async function resetUserBalanceToDefault(input: {
  token: string
  roomCode?: string
  playerId?: string
}) {
  const user = await getUserByToken(input.token)
  if (user.balance >= DEFAULT_BALANCE) {
    throw createError({ statusCode: 409, statusMessage: 'Сброс доступен только если баланс меньше 5000' })
  }

  return prisma.$transaction(async (tx) => {
    const activeSession = await tx.player.findFirst({
      where: {
        userId: user.id,
        isConnected: true,
        room: {
          status: { not: 'lobby' }
        }
      },
      select: { id: true }
    })

    if (activeSession) {
      throw createError({ statusCode: 409, statusMessage: 'Сброс баланса доступен только в лобби' })
    }

    const updatedUser = await tx.user.update({
      where: { id: user.id },
      data: {
        balance: DEFAULT_BALANCE,
        updatedAt: new Date()
      }
    })

    if (input.roomCode && input.playerId) {
      const room = await tx.room.findUnique({ where: { code: input.roomCode } })
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
      }

      if (room.status !== 'lobby') {
        throw createError({ statusCode: 409, statusMessage: 'Баланс можно обновлять только в лобби' })
      }

      await tx.player.updateMany({
        where: {
          id: input.playerId,
          roomId: room.id,
          userId: user.id
        },
        data: {
          stack: DEFAULT_BALANCE,
          updatedAt: new Date(),
          status: 'waiting'
        }
      })
    }

    return toPublicUser(updatedUser)
  })
}

export async function normalizeUserBalanceIfNeeded(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return null
  }

  if (user.balance > 0) {
    return user
  }

  return prisma.user.update({
    where: { id: user.id },
    data: {
      balance: DEFAULT_BALANCE,
      updatedAt: new Date()
    }
  })
}
