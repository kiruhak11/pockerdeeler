import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { assertCheckoutLegalAccepted, type LegalAcceptanceContext } from './legalService'
import { adjustUserWallet } from './walletService'
import { premiumExpiresAt } from './premiumService'
import { evaluateRefundEligibility, isRefundRequestable, refundReasonLabel } from '../utils/refundEligibility'
import { notifyAdminTelegram } from './adminTelegramNotificationService'
import { dispatchUserTelegram } from './notificationService'
import { getPremiumPaymentPlan, getVirtualCurrencyPackage, PREMIUM_PAYMENT_PLANS, VIRTUAL_CURRENCY_PACKAGES } from './paymentCatalog'
import type { PremiumPaymentPlan, VirtualCurrencyPackageId } from './paymentCatalog'
export { PREMIUM_PAYMENT_PLANS, VIRTUAL_CURRENCY_PACKAGES } from './paymentCatalog'
export type { PremiumPaymentPlan, VirtualCurrencyPackageId } from './paymentCatalog'

export type PaymentType = 'PREMIUM' | 'VIRTUAL_CURRENCY'
type ProviderPayment = {
  id?: string
  status?: string
  paid?: boolean
  amount?: { value?: string; currency?: string }
  metadata?: Record<string, string>
  confirmation?: { confirmation_url?: string }
  created_at?: string
  expires_at?: string
}

function getYooKassaConfig() {
  const shopId = process.env.YOOKASSA_SHOP_ID || ''
  const secretKey = process.env.YOOKASSA_SECRET_KEY || ''
  if (!shopId || !secretKey) throw createError({ statusCode: 503, message: 'Платежи временно недоступны' })
  if (shopId !== '1468251') throw createError({ statusCode: 503, message: 'Платежный магазин не настроен' })
  return { shopId, secretKey }
}

function appOrigin() {
  const raw = process.env.NUXT_PUBLIC_APP_URL
  if (!raw) throw createError({ statusCode: 503, message: 'Адрес платежного возврата не настроен' })
  const url = new URL(raw)
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw createError({ statusCode: 503, message: 'Платежный возврат должен использовать HTTPS' })
  return url.origin
}

function money(value: number) { return value.toFixed(2) }
function providerSnapshot(payment: ProviderPayment) {
  return { status: payment.status || null, paid: payment.paid === true, amount: payment.amount || null }
}
function sameMoney(value: unknown, expected: number) { return typeof value === 'string' && Number(value).toFixed(2) === money(expected) }

async function yooRequest(path: string, init: RequestInit = {}) {
  const { shopId, secretKey } = getYooKassaConfig()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`)
  headers.set('Accept', 'application/json')
  const response = await fetch(`https://api.yookassa.ru/v3${path}`, { ...init, headers })
  const body = await response.json().catch(() => null) as ProviderPayment | null
  if (!response.ok || !body) throw createError({ statusCode: 502, message: 'Платежный провайдер временно недоступен' })
  return body
}

async function getOrCreateCheckoutPayment(input: { userId: string; type: PaymentType; productKey: string; priceRub: number; metadata: Record<string, string>; legalContext: LegalAcceptanceContext; requestId: string }) {
  const internalPaymentId = randomUUID()
  const orderId = `order_${internalPaymentId.replaceAll('-', '')}`
  const idempotencyKey = randomUUID()
  const returnUrl = `${appOrigin()}/payments/return?payment=${internalPaymentId}`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async tx => {
        const checkout = await tx.legalCheckoutSession.findUnique({ where: { id: input.requestId } })
        if (!checkout) throw createError({ statusCode: 409, message: 'Checkout не найден' })
        if (checkout.userId !== input.userId) throw createError({ statusCode: 403, message: 'Checkout принадлежит другому пользователю' })
        if (checkout.context !== input.legalContext) throw createError({ statusCode: 409, message: 'Контекст checkout не совпадает с платежом' })
        if (checkout.paymentType && (checkout.paymentType !== input.type || checkout.productKey !== input.productKey)) throw createError({ statusCode: 409, message: 'Checkout уже связан с другим продуктом' })
        const existing = await tx.payment.findUnique({ where: { checkoutId: input.requestId } })
        if (existing) {
          if (existing.userId !== input.userId || existing.type !== input.type || existing.productKey !== input.productKey || Number(existing.amount) !== input.priceRub || existing.currency !== 'RUB') throw createError({ statusCode: 409, message: 'Существующий заказ не соответствует выбранному товару' })
          return existing
        }
        await tx.legalCheckoutSession.update({ where: { id: checkout.id }, data: { paymentType: input.type, productKey: input.productKey } })
        return tx.payment.create({ data: {
          id: internalPaymentId,
          userId: input.userId,
          checkoutId: input.requestId,
          orderId,
          idempotencyKey,
          type: input.type,
          productKey: input.productKey,
          amount: money(input.priceRub),
          currency: 'RUB',
          status: 'PENDING',
          description: input.type === 'PREMIUM' ? `Premium ${input.productKey}` : `Виртуальные фишки ${input.productKey}`,
          metadata: { ...input.metadata, productKey: input.productKey, internalPaymentId, orderId, checkoutId: input.requestId },
          returnUrl
        } })
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
        continue
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002' && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
  throw createError({ statusCode: 503, message: 'Платеж временно создается, повторите попытку' })
}

export async function bindCheckoutLegalAcceptance(input: { userId: string; context: LegalAcceptanceContext; requestId: string; paymentId: string; orderId: string }) {
  const checkout = await prisma.legalCheckoutSession.findUnique({ where: { id: input.requestId } })
  if (!checkout) throw createError({ statusCode: 409, message: 'Checkout не найден' })
  if (checkout.userId !== input.userId) throw createError({ statusCode: 403, message: 'Checkout принадлежит другому пользователю' })
  if (checkout.context !== input.context) throw createError({ statusCode: 409, message: 'Контекст checkout не совпадает' })
  const payment = await prisma.payment.findUnique({ where: { checkoutId: input.requestId } })
  if (!payment || payment.userId !== input.userId) throw createError({ statusCode: 403, message: 'Платеж не принадлежит checkout' })
  const paymentContext = payment.type === 'PREMIUM' ? 'PREMIUM' : payment.type === 'VIRTUAL_CURRENCY' ? 'VIRTUAL_CHIPS' : null
  if (paymentContext !== input.context || payment.yookassaPaymentId !== input.paymentId) throw createError({ statusCode: 409, message: 'Платеж не соответствует checkout' })
  const existing = await prisma.legalAcceptance.findMany({ where: { requestId: input.requestId }, select: { userId: true, context: true, paymentId: true, orderId: true } })
  if (existing.some(row => row.userId !== input.userId || (row.context !== input.context && !(input.context !== 'PERSONAL_DATA' && row.context === 'PERSONAL_DATA')))) throw createError({ statusCode: 409, message: 'Acceptance не принадлежит checkout' })
  if (existing.some(row => row.paymentId && row.paymentId !== input.paymentId)) throw createError({ statusCode: 409, message: 'Acceptance уже связана с другим платежом' })
  await prisma.legalAcceptance.updateMany({ where: { userId: input.userId, requestId: input.requestId, paymentId: null }, data: { paymentId: input.paymentId, orderId: input.orderId } })
  return { paymentId: input.paymentId, orderId: input.orderId }
}

export async function createYooKassaPayment(input: { userId: string; type: PaymentType; productKey: string; priceRub: number; metadata: Record<string, string>; legalContext: LegalAcceptanceContext; requestId: string }) {
  if (input.metadata.userId && input.metadata.userId !== input.userId) throw createError({ statusCode: 403, message: 'Платеж не принадлежит пользователю' })
  if (input.metadata.type && input.metadata.type !== input.type) throw createError({ statusCode: 409, message: 'Тип платежа не совпадает с checkout' })
  if (input.type === 'PREMIUM' && input.metadata.plan && input.metadata.plan !== input.productKey) throw createError({ statusCode: 409, message: 'Тариф платежа не совпадает с checkout' })
  if (input.type === 'PREMIUM') {
    const plan = getPremiumPaymentPlan(input.productKey)
    if (!plan || plan.priceRub !== input.priceRub) throw createError({ statusCode: 409, message: 'Тариф или цена платежа не соответствует серверному каталогу' })
  }
  if (input.type === 'VIRTUAL_CURRENCY' && input.metadata.packageId && input.metadata.packageId !== input.productKey) throw createError({ statusCode: 409, message: 'Пакет платежа не совпадает с checkout' })
  if (input.type === 'VIRTUAL_CURRENCY') {
    const pack = getVirtualCurrencyPackage(input.productKey)
    if (!pack || pack.priceRub !== input.priceRub) throw createError({ statusCode: 409, message: 'Пакет или цена платежа не соответствует серверному каталогу' })
  }
  await assertCheckoutLegalAccepted(input.userId, input.legalContext, input.requestId)
  const local = await getOrCreateCheckoutPayment(input)
  if (local?.confirmationUrl && local.yookassaPaymentId) {
    await bindCheckoutLegalAcceptance({ userId: input.userId, context: input.legalContext, requestId: input.requestId, paymentId: local.yookassaPaymentId, orderId: local.orderId })
    return { id: local.id, status: local.status, confirmationUrl: local.confirmationUrl, reused: true }
  }

  if (Number(local.amount) !== input.priceRub || local.currency !== 'RUB') {
    throw createError({ statusCode: 409, message: 'Существующий заказ не соответствует выбранному товару' })
  }

  try {
    const provider = await yooRequest('/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotence-Key': local.idempotencyKey },
      body: JSON.stringify({ amount: { value: money(Number(local.amount)), currency: 'RUB' }, capture: true, confirmation: { type: 'redirect', return_url: local.returnUrl }, description: local.description, metadata: { ...input.metadata, internalPaymentId: local.id, checkoutId: input.requestId } })
    })
    if (!provider.id || !provider.confirmation?.confirmation_url) throw createError({ statusCode: 502, message: 'ЮKassa не вернула ссылку на оплату' })
    await prisma.payment.update({ where: { id: local.id }, data: { yookassaPaymentId: provider.id, providerStatus: provider.status || 'pending', confirmationUrl: provider.confirmation.confirmation_url, providerCreatedAt: provider.created_at ? new Date(provider.created_at) : null, expiresAt: provider.expires_at ? new Date(provider.expires_at) : null, lastSyncedAt: new Date() } })
    await bindCheckoutLegalAcceptance({ userId: input.userId, context: input.legalContext, requestId: input.requestId, paymentId: provider.id, orderId: local.orderId })
    return { id: local.id, status: 'PENDING', confirmationUrl: provider.confirmation.confirmation_url, reused: false }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 502, message: 'Не удалось создать платеж' })
  }
}

function validateProvider(expectedPaymentId: string, local: { userId: string; type: string; amount: Prisma.Decimal; currency: string; metadata: Prisma.JsonValue }, provider: ProviderPayment) {
  const metadata = local.metadata as Record<string, unknown>
  if (!provider.id || provider.id !== expectedPaymentId) throw createError({ statusCode: 409, message: 'Платеж не прошел проверку' })
  if (!sameMoney(provider.amount?.value, Number(local.amount)) || provider.amount?.currency !== local.currency) throw createError({ statusCode: 409, message: 'Сумма или валюта платежа не совпадает' })
  if (provider.metadata?.internalPaymentId && provider.metadata.internalPaymentId !== metadata.internalPaymentId) throw createError({ statusCode: 409, message: 'Платеж не принадлежит заказу' })
  if (provider.metadata?.userId && provider.metadata.userId !== metadata.userId) throw createError({ statusCode: 409, message: 'Платеж не принадлежит пользователю' })
  if (provider.metadata?.type && provider.metadata.type !== local.type) throw createError({ statusCode: 409, message: 'Тип платежа не совпадает' })
}

export const PAYMENT_TRANSACTION_MAX_ATTEMPTS = 5
const PAYMENT_TRANSACTION_RETRY_DELAYS_MS = [20, 40, 80, 120] as const

export function isSerializationConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  const meta = 'meta' in error && error.meta && typeof error.meta === 'object' ? error.meta as { code?: string } : undefined
  // Prisma can surface PostgreSQL's serialization SQLSTATE as P2010/40001.
  return code === 'P2034' || (code === 'P2010' && meta?.code === '40001')
}

type PaymentTransactionRetryOptions = {
  maxAttempts?: number
  sleep?: (delayMs: number) => Promise<void>
}

export async function retryPaymentTransaction<T>(operation: () => Promise<T>, options: PaymentTransactionRetryOptions = {}) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? PAYMENT_TRANSACTION_MAX_ATTEMPTS))
  const sleep = options.sleep || ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)))

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === maxAttempts - 1) throw error
      await sleep(PAYMENT_TRANSACTION_RETRY_DELAYS_MS[Math.min(attempt, PAYMENT_TRANSACTION_RETRY_DELAYS_MS.length - 1)]!)
    }
  }

  throw new Error('Payment transaction retry exhausted')
}

type PaymentNotificationResult = { duplicate: boolean; status: string }
type PaymentNotificationLocal = { userId: string; type: string; amount: { toString(): string }; currency: string }
type PaymentNotificationDependencies = {
  notifyAdmin: typeof notifyAdminTelegram
  dispatchUser: typeof dispatchUserTelegram
}

export async function notifyPaymentResult(result: PaymentNotificationResult, local: PaymentNotificationLocal, dependencies: PaymentNotificationDependencies = { notifyAdmin: notifyAdminTelegram, dispatchUser: dispatchUserTelegram }) {
  if (result.duplicate || (result.status !== 'PROCESSED' && result.status !== 'CANCELED')) return
  await dependencies.notifyAdmin('payments', `Платёж ${result.status === 'PROCESSED' ? 'обработан' : 'отменён'}: ${local.type}, ${local.amount.toString()} ${local.currency}.`)
  if (result.status !== 'PROCESSED') return
  dependencies.dispatchUser(local.userId, 'purchases', local.type === 'PREMIUM' ? 'Покупка Premium успешно активирована.' : 'Покупка виртуальных фишек успешно зачислена.')
  if (local.type === 'PREMIUM') void dependencies.notifyAdmin('premium', `Premium активирован покупкой для пользователя ${local.userId}.`)
}

export async function syncAndProcessPayment(yookassaPaymentId: string) {
  const provider = await yooRequest(`/payments/${encodeURIComponent(yookassaPaymentId)}`)
  const local = await prisma.payment.findUnique({ where: { yookassaPaymentId } })
  if (!local) throw createError({ statusCode: 404, message: 'Платеж не найден' })
  validateProvider(yookassaPaymentId, { userId: local.userId, type: local.type, amount: local.amount, currency: local.currency, metadata: local.metadata }, provider)

  const processTransaction = () => prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id=${local.id}::uuid FOR UPDATE`
    const locked = await tx.payment.findUniqueOrThrow({ where: { id: local.id } })
    const safeProviderData = providerSnapshot(provider)
    if (locked.status === 'PROCESSED') return { success: true, duplicate: true, status: locked.status }
    if (provider.status === 'canceled') {
      const canceled = await tx.payment.update({ where: { id: locked.id }, data: { status: 'CANCELED', providerStatus: provider.status, canceledAt: locked.canceledAt || new Date(), lastSyncedAt: new Date(), providerData: safeProviderData } })
      return { success: true, duplicate: false, status: canceled.status }
    }
    if (provider.status !== 'succeeded' || provider.paid !== true) {
      await tx.payment.update({ where: { id: locked.id }, data: { providerStatus: provider.status || 'pending', lastSyncedAt: new Date(), providerData: safeProviderData } })
      return { success: true, duplicate: false, status: 'PENDING' }
    }
    const metadata = locked.metadata as Record<string, string>
    if (locked.type === 'VIRTUAL_CURRENCY') {
      const pack = VIRTUAL_CURRENCY_PACKAGES[metadata.packageId as VirtualCurrencyPackageId]
      if (!pack || pack.priceRub !== Number(locked.amount)) throw createError({ statusCode: 409, message: 'Пакет платежа не найден' })
      await adjustUserWallet(tx, { userId: locked.userId, delta: BigInt(pack.chips), entryType: 'PURCHASE_VIRTUAL_CURRENCY', idempotencyKey: `payment:${locked.id}:wallet`, metadata: { paymentId: locked.id, packageId: pack.packageId, chips: pack.chips } })
    } else if (locked.type === 'PREMIUM') {
      const plan = PREMIUM_PAYMENT_PLANS[metadata.plan as PremiumPaymentPlan]
      if (!plan || plan.priceRub !== Number(locked.amount)) throw createError({ statusCode: 409, message: 'Тариф платежа не найден' })
      const now = new Date()
      const current = await tx.premiumSubscription.findFirst({ where: { userId: locked.userId, status: 'ACTIVE', expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } })
      if (current) await tx.premiumSubscription.update({ where: { id: current.id }, data: { plan: plan.plan, expiresAt: premiumExpiresAt(new Date(Math.max(now.getTime(), current.expiresAt.getTime()))) } })
      else await tx.premiumSubscription.create({ data: { userId: locked.userId, plan: plan.plan, startedAt: now, expiresAt: premiumExpiresAt(now), status: 'ACTIVE' } })
    } else throw createError({ statusCode: 409, message: 'Тип платежа не поддерживается' })
    await tx.payment.update({ where: { id: locked.id }, data: { status: 'PROCESSED', providerStatus: 'succeeded', paidAt: locked.paidAt || new Date(), processedAt: new Date(), lastSyncedAt: new Date(), providerData: safeProviderData } })
    return { success: true, duplicate: false, status: 'PROCESSED' }
  }, { isolationLevel: 'Serializable' })

  // YooKassa was verified once above; only the local DB transaction is retried.
  const result = await retryPaymentTransaction(processTransaction)
  await notifyPaymentResult(result, local)
  return result
}

export async function paymentHistory(userId: string) {
  const rows = await prisma.payment.findMany({ where: { userId }, include: { refundRequest: true }, orderBy: { createdAt: 'desc' }, take: 100 })
  return rows.map(row => {
    const metadata = row.metadata as Record<string, string>
    const plan = PREMIUM_PAYMENT_PLANS[metadata.plan as PremiumPaymentPlan]
    const pack = VIRTUAL_CURRENCY_PACKAGES[metadata.packageId as VirtualCurrencyPackageId]
    const refundEligibility = evaluateRefundEligibility({
      type: row.type, status: row.status, paidAt: row.paidAt,
      processedAt: row.processedAt, createdAt: row.createdAt,
      refundStatus: row.refundRequest?.status ?? null
    })
    return {
      id: row.id,
      paymentId: row.yookassaPaymentId,
      createdAt: row.createdAt.toISOString(),
      type: row.type,
      item: plan?.name || (pack ? `${pack.chips.toLocaleString('ru-RU')} фишек` : 'Покупка'),
      chips: pack?.chips || null,
      amountRub: Number(row.amount),
      status: row.status,
      refund: row.refundRequest ? {
        status: row.refundRequest.status,
        requestedAt: row.refundRequest.requestedAt.toISOString(),
        processedAt: row.refundRequest.processedAt?.toISOString() || null,
        decisionReason: row.refundRequest.decisionReason
      } : null,
      refundEligibility: { code: refundEligibility, eligible: isRefundRequestable(refundEligibility), message: refundReasonLabel(refundEligibility) }
    }
  })
}
