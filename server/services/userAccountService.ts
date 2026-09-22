import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { ensureUserWallet } from './walletService'
import { toChipNumber } from '../utils/chips'
import type { Prisma } from '@prisma/client'
import { resolveRoomSecretPepper } from '../utils/roomSecretPepper'

const DEFAULT_BALANCE = 5000
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function hashPassword(password: string, salt?: string): string {
  const localSalt = salt || randomBytes(16).toString('hex')
  const derived = scryptSync(`${password}:${resolveRoomSecretPepper()}`, localSalt, 64).toString('hex')
  return `${localSalt}:${derived}`
}

export function verifyPassword(password: string, storedHash: string): boolean {
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

export function sessionHash(token: string): string { return createHash('sha256').update(token).digest('hex') }

export async function issueUserAuthToken(userId: string, client: Pick<Prisma.TransactionClient, 'accountSession'> = prisma): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await client.accountSession.create({ data: { userId, tokenHash: sessionHash(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) } })
  return token
}

export async function verifyUserAuthToken(token: string, client: Pick<Prisma.TransactionClient, 'accountSession'> = prisma): Promise<{ userId: string } | null> {
  if (!token || token.length < 32) return null
  const session = await client.accountSession.findUnique({ where: { tokenHash: sessionHash(token) }, include: { user: true } })
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || session.user.blockedAt || session.user.deletedAt) return null
  return { userId: session.userId }
}

function toPublicUser(user: { id: string; username: string; balance: number; predictionRating?: number; tableRating?: number; tableHandsPlayed?: number; tableHandsWon?: number; tableCurrentStreak?: number; tableBestStreak?: number; predictionCount?: number; predictionWins?: number; predictionSplitWins?: number; premiumType?: string; premiumUntil?: Date | null; lastDailyBonusAt?: Date | null; phone?: string | null; phoneVerifiedAt?: Date | null; role?: string; mustChangePassword?: boolean }, wallet?: { balance: bigint; version: number } | null) {
  return {
    id: user.id,
    username: user.username,
    phone: user.phone ?? null, phoneVerified: Boolean(user.phoneVerifiedAt), role: (user.role === 'SUPERADMIN' || user.role === 'ADMIN' ? user.role : 'USER') as 'USER' | 'ADMIN' | 'SUPERADMIN', mustChangePassword: user.mustChangePassword || false,
    balance: wallet ? toChipNumber(wallet.balance) : user.balance,
    predictionRating: user.predictionRating ?? 1000,
    tableRating: user.tableRating ?? 1000,
    tableHandsPlayed: user.tableHandsPlayed ?? 0,
    tableHandsWon: user.tableHandsWon ?? 0,
    tableCurrentStreak: user.tableCurrentStreak ?? 0,
    tableBestStreak: user.tableBestStreak ?? 0,
    predictionCount: user.predictionCount ?? 0,
    predictionWins: user.predictionWins ?? 0,
    predictionSplitWins: user.predictionSplitWins ?? 0,
    selectedAchievementCode: (user as { selectedAchievementCode?: string | null }).selectedAchievementCode ?? null,
    premiumType: (user.premiumType === 'PREMIUM' ? 'PREMIUM' : 'FREE') as 'FREE' | 'PREMIUM',
    premiumUntil: user.premiumUntil?.toISOString() ?? null,
    walletVersion: wallet?.version,
    nextDailyBonusAt: user.lastDailyBonusAt ? new Date(user.lastDailyBonusAt.getTime() + 86_400_000).toISOString() : null
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

  const { user, wallet } = await prisma.$transaction(async tx => {
    const createdUser = await tx.user.create({
      data: { username, passwordHash: hashPassword(password), balance: DEFAULT_BALANCE }
    })
    const createdWallet = await tx.userWallet.create({
      data: { userId: createdUser.id, balance: BigInt(DEFAULT_BALANCE) }
    })
    await tx.walletLedgerEntry.create({
      data: {
        walletId: createdWallet.id,
        transferId: randomUUID(),
        entryType: 'ACCOUNT_OPENING_GRANT',
        amount: BigInt(DEFAULT_BALANCE),
        balanceAfter: BigInt(DEFAULT_BALANCE),
        idempotencyKey: `wallet-opening:${createdUser.id}`,
        metadata: { reason: 'account_created' }
      }
    })
    return { user: createdUser, wallet: createdWallet }
  })

  return {
    user: toPublicUser(user, wallet),
    token: await issueUserAuthToken(user.id)
  }
}

export async function loginUser(input: { username: string; password: string }) {
  const username = normalizeUsername(input.username)
  const phone = input.username.replace(/[^0-9]/g, '')
  const normalized = phone.length === 11 && ['7', '8'].includes(phone[0]!) ? '+7' + phone.slice(1) : input.username
  const user = await prisma.user.findFirst({ where: { ...(normalized.startsWith('+7') ? { phone: normalized, phoneVerifiedAt: { not: null } } : { username }), deletedAt: null }, include: { wallet: true } })
  if (process.env.NODE_ENV === 'production' && !normalized.startsWith('+7')) throw createError({ statusCode: 401, message: 'Войдите по подтверждённому телефону' })
  if (!user || user.deletedAt || user.blockedAt || !verifyPassword(input.password, user.passwordHash)) {
    throw createError({ statusCode: 401, statusMessage: 'Неверный логин или пароль' })
  }

  return {
    user: toPublicUser(user, user.wallet),
    token: await issueUserAuthToken(user.id)
  }
}

export async function updateUsername(input: { token: string; username: string }) {
  const user = await getUserByToken(input.token)
  const nextUsername = normalizeUsername(input.username)

  if (nextUsername.length < 3 || nextUsername.length > 32) {
    throw createError({ statusCode: 400, statusMessage: 'Логин должен быть длиной от 3 до 32 символов' })
  }

  if (nextUsername === user.username) {
    return toPublicUser(user, await prisma.userWallet.findUnique({ where: { userId: user.id } }))
  }

  const exists = await prisma.user.findUnique({
    where: { username: nextUsername },
    select: { id: true }
  })

  if (exists) {
    throw createError({ statusCode: 409, statusMessage: 'Пользователь с таким логином уже существует' })
  }

  const now = new Date()
  const updatedUser = await prisma.$transaction(async (tx) => {
    const saved = await tx.user.update({
      where: { id: user.id },
      data: {
        username: nextUsername,
        updatedAt: now
      }
    })

    await tx.roomParticipant.updateMany({
      where: {
        userId: user.id,
        role: 'player',
        isConnected: true
      },
      data: {
        name: nextUsername,
        lastSeenAt: now
      }
    })

    await tx.player.updateMany({
      where: {
        userId: user.id,
        isConnected: true
      },
      data: {
        name: nextUsername,
        updatedAt: now
      }
    })

    return saved
  })

  return toPublicUser(updatedUser, await prisma.userWallet.findUnique({ where: { userId: user.id } }))
}

export async function changePassword(input: {
  token: string
  currentPassword: string
  newPassword: string
}) {
  const user = await getUserByToken(input.token)

  if (input.newPassword.length < 12 || input.newPassword.length > 128) {
    throw createError({ statusCode: 400, statusMessage: 'Новый пароль должен быть длиной от 12 до 128 символов' })
  }

  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    throw createError({ statusCode: 401, statusMessage: 'Текущий пароль указан неверно' })
  }

  if (input.currentPassword === input.newPassword) {
    throw createError({ statusCode: 409, statusMessage: 'Новый пароль должен отличаться от текущего' })
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(input.newPassword),
      mustChangePassword: false,
      updatedAt: new Date()
    }
  })

  await prisma.accountSession.updateMany({ where: { userId: user.id, tokenHash: { not: sessionHash(input.token) } }, data: { revokedAt: new Date() } })
  return toPublicUser(updatedUser, await prisma.userWallet.findUnique({ where: { userId: user.id } }))
}

export async function getUserByToken(token: string) {
  const verified = await verifyUserAuthToken(token)
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
  const wallet = await prisma.$transaction(tx => ensureUserWallet(tx, user.id))
  return toPublicUser(user, wallet)
}

// Retired endpoints must not bypass reward sessions or recreate zero balances.
export async function claimDailyBonus(_token: string): Promise<never> {
  throw createError({ statusCode: 410, message: 'Бонус доступен через 10-секундный просмотр в профиле' })
}
export async function resetUserBalanceToDefault(input: { token: string; roomCode?: string; playerId?: string }): Promise<never> {
  return claimDailyBonus(input.token)
}
