import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import {
  DEFAULT_BALANCE,
  hashPassword,
  issueUserAuthToken,
  sessionHash,
  toPublicUser,
  verifyUserAuthToken
} from './userAccountService'

export const YANDEX_IDENTITY_PROVIDER = 'YANDEX_GAMES'
const WS_TICKET_TTL_MS = 30_000
const MAX_SIGNATURE_LENGTH = 24_000

export type VerifiedYandexPlayer = Readonly<{
  providerUserId: string
}>

function invalidSignature(): never {
  throw createError({ statusCode: 401, statusMessage: 'Подпись игрока Яндекс недействительна' })
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > MAX_SIGNATURE_LENGTH || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalidSignature()
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) invalidSignature()
  return decoded
}

/** Verifies the SDK format `<base64 hmac>.<base64 JSON profile>` over decoded profile bytes. */
export function verifyYandexPlayerSignature(signature: string, secret = process.env.YANDEX_GAMES_SECRET): VerifiedYandexPlayer {
  if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && process.env.YANDEX_GAMES_DEV_MOCK === 'true' && signature === 'dev-mock-authorized-player') {
    return { providerUserId: 'dev-yandex-authorized' }
  }
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Авторизация Яндекс временно недоступна' })
  if (typeof signature !== 'string' || signature.length > MAX_SIGNATURE_LENGTH) invalidSignature()
  const parts = signature.split('.')
  if (parts.length !== 2) invalidSignature()
  const supplied = decodeBase64(parts[0]!)
  const profileBytes = decodeBase64(parts[1]!)
  const expected = createHmac('sha256', secret).update(profileBytes).digest()
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalidSignature()

  let profile: unknown
  try { profile = JSON.parse(profileBytes.toString('utf8')) } catch { invalidSignature() }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) invalidSignature()
  // `uniqueID` is the SDK's current permanent player identifier. Profile fields
  // such as name/avatar are deliberately not treated as identity proof.
  const uniqueID = (profile as Record<string, unknown>).uniqueID
  if (typeof uniqueID !== 'string' || uniqueID.length < 1 || uniqueID.length > 256 || /[\u0000-\u001f\u007f]/.test(uniqueID)) invalidSignature()
  return { providerUserId: uniqueID }
}

async function currentYandexUser(token: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const auth = await verifyUserAuthToken(token, client)
  if (!auth) return null
  return client.user.findFirst({ where: { id: auth.userId, accountOrigin: YANDEX_IDENTITY_PROVIDER }, include: { wallet: true } })
}

async function publicSession(userId: string, token: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { wallet: true } })
  return { user: toPublicUser(user, user.wallet), token }
}

export async function createOrResumeYandexGuest(resumeToken?: string | null) {
  if (resumeToken) {
    const existing = await currentYandexUser(resumeToken)
    if (existing) return { user: toPublicUser(existing, existing.wallet), token: resumeToken, resumed: true }
  }

  const result = await prisma.$transaction(async tx => {
    const suffix = randomBytes(7).toString('hex')
    const user = await tx.user.create({
      data: {
        username: `yandex_${suffix}`,
        passwordHash: hashPassword(randomBytes(32).toString('base64url')),
        balance: DEFAULT_BALANCE,
        accountOrigin: YANDEX_IDENTITY_PROVIDER
      }
    })
    const wallet = await tx.userWallet.create({ data: { userId: user.id, balance: BigInt(DEFAULT_BALANCE) } })
    await tx.walletLedgerEntry.create({
      data: {
        walletId: wallet.id,
        transferId: randomUUID(),
        entryType: 'ACCOUNT_OPENING_GRANT',
        amount: BigInt(DEFAULT_BALANCE),
        balanceAfter: BigInt(DEFAULT_BALANCE),
        idempotencyKey: `wallet-opening:${user.id}`,
        metadata: { reason: 'account_created', platform: YANDEX_IDENTITY_PROVIDER }
      }
    })
    return { userId: user.id, token: await issueUserAuthToken(user.id, tx) }
  })
  return { ...(await publicSession(result.userId, result.token)), resumed: false }
}

async function exchangeTransaction(currentToken: string, providerUserId: string) {
  return prisma.$transaction(async tx => {
    // Serialize the same verified provider identity across tabs/processes. The
    // database unique constraints remain the final integrity barrier.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${providerUserId}, 0))::text`
    const current = await currentYandexUser(currentToken, tx)
    if (!current) throw createError({ statusCode: 401, statusMessage: 'Yandex guest session недействительна' })
    const existing = await tx.externalIdentity.findUnique({
      where: { provider_providerUserId: { provider: YANDEX_IDENTITY_PROVIDER, providerUserId } }
    })
    if (existing) {
      const owner = await tx.user.findUnique({ where: { id: existing.userId }, select: { accountOrigin: true, blockedAt: true, deletedAt: true } })
      if (!owner || owner.accountOrigin !== YANDEX_IDENTITY_PROVIDER || owner.blockedAt || owner.deletedAt) {
        throw createError({ statusCode: 409, statusMessage: 'Yandex ID не может быть связан с WEB-аккаунтом' })
      }
    }
    let targetUserId = existing?.userId
    if (!targetUserId) {
      const otherIdentity = await tx.externalIdentity.findUnique({
        where: { provider_userId: { provider: YANDEX_IDENTITY_PROVIDER, userId: current.id } }
      })
      if (otherIdentity && otherIdentity.providerUserId !== providerUserId) {
        throw createError({ statusCode: 409, statusMessage: 'Гостевой аккаунт уже связан с другим Yandex ID' })
      }
      if (!otherIdentity) {
        await tx.externalIdentity.create({ data: { provider: YANDEX_IDENTITY_PROVIDER, providerUserId, userId: current.id } })
      }
      targetUserId = current.id
    }

    if (targetUserId === current.id) {
      await tx.accountSession.updateMany({ where: { tokenHash: sessionHash(currentToken), revokedAt: null }, data: { revokedAt: new Date() } })
    } else {
      // The detached guest economy is intentionally not merged into an existing identity.
      await tx.accountSession.updateMany({ where: { userId: current.id, revokedAt: null }, data: { revokedAt: new Date() } })
    }
    return { userId: targetUserId, token: await issueUserAuthToken(targetUserId, tx), linkedCurrentGuest: targetUserId === current.id }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}

export async function exchangeYandexIdentity(input: { currentToken: string; signature: string; secret?: string }) {
  const verified = verifyYandexPlayerSignature(input.signature, input.secret)
  let result: Awaited<ReturnType<typeof exchangeTransaction>> | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await exchangeTransaction(input.currentToken, verified.providerUserId)
      break
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2002', 'P2034'].includes(error.code) || attempt === 2) throw error
    }
  }
  if (!result) throw createError({ statusCode: 409, statusMessage: 'Не удалось завершить привязку Yandex ID' })
  return { ...(await publicSession(result.userId, result.token)), linkedCurrentGuest: result.linkedCurrentGuest }
}

export async function getYandexSession(token: string) {
  const user = await currentYandexUser(token)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Yandex session недействительна' })
  const identity = await prisma.externalIdentity.findUnique({
    where: { provider_userId: { provider: YANDEX_IDENTITY_PROVIDER, userId: user.id } }
  })
  return { user: toPublicUser(user, user.wallet), authorized: Boolean(identity) }
}

export async function issueWebSocketAuthTicket(token: string): Promise<string> {
  const user = await currentYandexUser(token)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Yandex session недействительна' })
  const ticket = randomBytes(32).toString('base64url')
  await prisma.$transaction(async tx => {
    await tx.webSocketAuthTicket.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    await tx.webSocketAuthTicket.create({
      data: { userId: user.id, tokenHash: sessionHash(ticket), expiresAt: new Date(Date.now() + WS_TICKET_TTL_MS) }
    })
  })
  return ticket
}

export async function consumeWebSocketAuthTicket(ticket: string): Promise<{ userId: string } | null> {
  if (!ticket || ticket.length < 32) return null
  return prisma.$transaction(async tx => {
    const tokenHash = sessionHash(ticket)
    const consumed = await tx.webSocketAuthTicket.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() }
    })
    if (consumed.count !== 1) return null
    const record = await tx.webSocketAuthTicket.findUnique({ where: { tokenHash }, select: { userId: true, user: { select: { blockedAt: true, deletedAt: true, isBot: true } } } })
    return record && !record.user.blockedAt && !record.user.deletedAt && !record.user.isBot ? { userId: record.userId } : null
  })
}
