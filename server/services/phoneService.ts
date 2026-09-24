import { randomBytes, randomUUID } from 'node:crypto'
import { createError, getCookie, getRequestHeader, getRequestIP, setCookie, type H3Event } from 'h3'
import { prisma } from '../db/client'
import { hashPassword, sessionHash, issueUserAuthToken, getUserProfile, getUserByToken } from './userAccountService'
import { acceptRegistrationLegalDocuments, assertRegistrationLegalConfirmations, ensureRegistrationLegalDocuments, type RegistrationLegalConfirmationInput } from './legalService'
import { isolatedAuthTests, accountCookie } from '../utils/accountCookie'
import { assertPhoneStartLimit } from '../utils/phoneStartLimit'

export function normalizePhone(value: string): string {
  const digits = value.replace(/[\s()+-]/g, '')
  if (!/^[78]\d{10}$/.test(digits)) throw createError({ statusCode: 400, message: 'Введите российский номер: +7 и ещё 10 цифр' })
  return '+7' + digits.slice(1)
}
export function callStatus(response: { status_code?: unknown; check_status?: unknown }) {
  if (Number(response.status_code) !== 100) return 'error'
  return Number(response.check_status) === 401 ? 'verified' : Number(response.check_status) === 402 ? 'expired' : 'pending'
}
export function verificationBrowser(event: H3Event) {
  let secret = getCookie(event, 'poker_phone_browser')
  if (!secret || !/^[a-zA-Z0-9_-]{43}$/.test(secret)) {
    secret = randomBytes(32).toString('base64url')
    setCookie(event, 'poker_phone_browser', secret, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 86400 })
  }
  return sessionHash(secret)
}
async function provider(endpoint: 'add' | 'status', parameters: Record<string, string>): Promise<Record<string, unknown>> {
  if (isolatedAuthTests() && process.env.SMS_RU_MODE === 'mock') return endpoint === 'add'
    ? { status_code: 100, check_id: randomUUID(), call_phone: '78005553535' }
    : { status_code: 100, check_status: process.env.SMS_RU_MOCK_STATUS || '400' }
  if (!process.env.SMS_RU_API_ID) throw createError({ statusCode: 503, message: 'Подтверждение телефона пока не настроено' })
  try {
    const response = await fetch(`https://sms.ru/callcheck/${endpoint}`, { method: 'POST', signal: AbortSignal.timeout(8000), body: new URLSearchParams({ api_id: process.env.SMS_RU_API_ID, json: '1', ...parameters }) })
    if (!response.ok) throw new Error('provider unavailable')
    return await response.json() as Record<string, unknown>
  } catch { throw createError({ statusCode: 503, message: 'Сервис звонков временно недоступен. Не создавайте повторную заявку сразу' }) }
}
function view(v: { id: string; phone: string; status: string; callPhone: string | null; expiresAt: Date }) {
  return { id: v.id, phone: v.phone, status: v.status, callPhone: v.callPhone, expiresAt: v.expiresAt.toISOString() }
}
export async function startPhoneVerification(event: H3Event, input: { phone: string; purpose: 'register' | 'recover' | 'link'; requestId: string }) {
  const phone = normalizePhone(input.phone), browserHash = verificationBrowser(event)
  if (input.purpose === 'link') await getUserByToken(accountCookie(event))
  const attempt = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${browserHash}, 0))::text`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phone}, 0))::text`
    const duplicate = await tx.phoneVerification.findUnique({ where: { requestId: input.requestId } })
    if (duplicate) {
      if (duplicate.browserHash !== browserHash || duplicate.phone !== phone || duplicate.purpose !== input.purpose) throw createError({ statusCode: 409, message: 'Заявка не принадлежит этой сессии' })
      // A provider outage may have left this idempotency record as failed. Retry
      // that same request after the server is fixed, without duplicating pending
      // or verified requests and without bypassing the hourly rate limit below.
      if (duplicate.status === 'failed' && duplicate.expiresAt > new Date()) {
        await assertPhoneStartLimit(event, phone)
        const retried = await tx.phoneVerification.update({ where: { id: duplicate.id }, data: { status: 'creating', providerId: null, callPhone: null, checkedAt: null } })
        return { value: retried, created: true }
      }
      return { value: duplicate, created: false }
    }
    const pending = await tx.phoneVerification.findFirst({ where: { browserHash, phone, purpose: input.purpose, consumedAt: null, expiresAt: { gt: new Date() }, status: { in: ['creating', 'pending', 'verified'] } } })
    if (pending) return { value: pending, created: false }
    await assertPhoneStartLimit(event, phone)
    const retryable = await tx.phoneVerification.findFirst({ where: { browserHash, phone, purpose: input.purpose, consumedAt: null, expiresAt: { gt: new Date() }, status: 'failed' }, orderBy: { createdAt: 'desc' } })
    if (retryable) {
      const retried = await tx.phoneVerification.update({ where: { id: retryable.id }, data: { status: 'creating', requestId: input.requestId, providerId: null, callPhone: null, checkedAt: null } })
      return { value: retried, created: true }
    }
    // SMS.ru currently documents a five-minute call window. Local expiry never extends it.
    const value = await tx.phoneVerification.create({ data: { phone, browserHash, purpose: input.purpose, requestId: input.requestId, expiresAt: new Date(Date.now() + 300000) } })
    return { value, created: true }
  })
  if (!attempt.created) return view(attempt.value)
  try {
    const data = await provider('add', { phone: phone.slice(1) })
    if (Number(data.status_code) !== 100 || typeof data.check_id !== 'string' || !/^\+?\d{10,15}$/.test(String(data.call_phone))) throw new Error('invalid provider response')
    return view(await prisma.phoneVerification.update({ where: { id: attempt.value.id }, data: { status: 'pending', providerId: data.check_id, callPhone: '+' + String(data.call_phone).replace(/^\+/, '') } }))
  } catch {
    await prisma.phoneVerification.update({ where: { id: attempt.value.id }, data: { status: 'failed' } })
    throw createError({ statusCode: 503, message: 'Не удалось создать проверку звонком. Повторите позднее' })
  }
}
export async function pollPhoneVerification(event: H3Event, id: string) {
  const browserHash = verificationBrowser(event)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM phone_verifications WHERE id = ${id}::uuid FOR UPDATE`
    let v = await tx.phoneVerification.findUnique({ where: { id } })
    if (!v || v.browserHash !== browserHash || v.consumedAt) throw createError({ statusCode: 403, message: 'Заявка недоступна' })
    if (v.expiresAt <= new Date()) v = await tx.phoneVerification.update({ where: { id }, data: { status: 'expired' } })
    if (v.status !== 'pending' || !v.providerId || (v.checkedAt && Date.now() - v.checkedAt.getTime() < 3000)) return view(v)
    const status = callStatus(await provider('status', { check_id: v.providerId }))
    if (status === 'error') throw createError({ statusCode: 503, message: 'Сервис пока не подтвердил проверку' })
    return view(await tx.phoneVerification.update({ where: { id }, data: { status, checkedAt: new Date() } }))
  }, { timeout: 12000 })
}
export async function completePhoneVerification(event: H3Event, input: { id: string; username?: string; password: string; legal?: RegistrationLegalConfirmationInput }) {
  const browserHash = verificationBrowser(event)
  if (input.password.length < 12 || input.password.length > 128) throw createError({ statusCode: 400, message: 'Пароль: от 12 до 128 символов' })
  // Registration's legal snapshots must be ready before the user/verification
  // transaction starts. Seeding them inside that transaction through the
  // global Prisma client deadlocks a one-connection PgBouncer pool.
  const verification = await prisma.phoneVerification.findUnique({ where: { id: input.id }, select: { purpose: true } })
  if (verification?.purpose === 'register') await ensureRegistrationLegalDocuments()
  // Only phone linking is authenticated by an existing account session. A
  // stale cookie must not prevent a new registration or password recovery.
  const linkedUser = verification?.purpose === 'link' && accountCookie(event) ? await getUserByToken(accountCookie(event)) : null
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM phone_verifications WHERE id = ${input.id}::uuid FOR UPDATE`
    const v = await tx.phoneVerification.findUnique({ where: { id: input.id } })
    if (!v || v.browserHash !== browserHash || v.status !== 'verified' || v.consumedAt || v.expiresAt <= new Date()) throw createError({ statusCode: 403, message: 'Сначала подтвердите номер звонком' })
    const owner = await tx.user.findUnique({ where: { phone: v.phone } })
    let id: string
    if (v.purpose === 'register') {
      const username = input.username?.trim().toLowerCase()
      if (!username || username.length < 3 || username.length > 32) throw createError({ statusCode: 400, message: 'Имя: от 3 до 32 символов' })
      if (owner || await tx.user.findUnique({ where: { username } })) throw createError({ statusCode: 409, message: 'Номер или имя уже заняты. Войдите или восстановите доступ' })
      if (!input.legal) throw createError({ statusCode: 400, message: 'Перед созданием аккаунта примите обязательные юридические документы' })
      assertRegistrationLegalConfirmations(input.legal)
      const u = await tx.user.create({ data: { username, phone: v.phone, phoneVerifiedAt: new Date(), passwordHash: hashPassword(input.password), balance: 5000 } })
      const wallet = await tx.userWallet.create({ data: { userId: u.id, balance: 5000n } })
      await tx.walletLedgerEntry.create({ data: { walletId: wallet.id, transferId: randomUUID(), entryType: 'ACCOUNT_OPENING_GRANT', amount: 5000n, balanceAfter: 5000n, idempotencyKey: `wallet-opening:${u.id}` } })
      id = u.id
      await acceptRegistrationLegalDocuments(tx, {
        userId: id,
        requestId: v.requestId,
        confirmations: input.legal,
        ip: getRequestIP(event, { xForwardedFor: true }) || 'unknown',
        userAgent: getRequestHeader(event, 'user-agent') || 'unknown'
      })
    } else {
      const target = v.purpose === 'link' ? linkedUser : owner
      if (!target || target.blockedAt || target.deletedAt || (owner && owner.id !== target.id)) throw createError({ statusCode: 403, message: 'Аккаунт недоступен или номер уже занят' })
      await tx.user.update({ where: { id: target.id }, data: { phone: v.phone, phoneVerifiedAt: new Date(), passwordHash: hashPassword(input.password), mustChangePassword: false } })
      await tx.accountSession.updateMany({ where: { userId: target.id }, data: { revokedAt: new Date() } })
      id = target.id
    }
    await tx.phoneVerification.update({ where: { id: v.id }, data: { status: 'consumed', consumedAt: new Date() } })
    return { id, token: await issueUserAuthToken(id, tx) }
  })
  return { user: await getUserProfile(result.token), token: result.token }
}
