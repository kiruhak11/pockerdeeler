import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp, toNodeListener } from 'h3'
import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'
import webhookHandler from '../server/api/payments/webhook.post'
import { notifyPaymentResult, PAYMENT_TRANSACTION_MAX_ATTEMPTS, retryPaymentTransaction } from '../server/services/paymentService'
import { registerUser } from '../server/services/userAccountService'
import { closePaymentWebhookRateLimitStore, consumePaymentWebhookCounters, PAYMENT_WEBHOOK_RATE_LIMITS } from '../server/utils/paymentWebhookRateLimit'

const testRedisUrl = process.env.PAYMENT_TEST_REDIS_URL
const isolated = Boolean(testRedisUrl && /^redis:\/\/127\.0\.0\.1:56380\/14$/.test(testRedisUrl) && process.env.DATABASE_URL?.includes('pocker_payment_webhook_test'))
const db = new PrismaClient()
const users: string[] = []
const payments: string[] = []
const originalFetch = globalThis.fetch
let server: ReturnType<typeof createServer> | undefined
let base = ''
let redis: Redis | undefined
let providerCalls = 0
let providerResponse: Record<string, unknown> = {}
let previousRedisUrl: string | undefined
let previousTrustedProxyIps: string | undefined
let previousShopId: string | undefined
let previousSecretKey: string | undefined

test.before(async () => {
  if (!isolated) return
  previousRedisUrl = process.env.REDIS_URL
  previousTrustedProxyIps = process.env.PHONE_TRUSTED_PROXY_IPS
  previousShopId = process.env.YOOKASSA_SHOP_ID
  previousSecretKey = process.env.YOOKASSA_SECRET_KEY
  process.env.REDIS_URL = testRedisUrl
  process.env.PHONE_TRUSTED_PROXY_IPS = ''
  process.env.YOOKASSA_SHOP_ID = '1468251'
  process.env.YOOKASSA_SECRET_KEY = 'test-webhook-secret'
  redis = new Redis(testRedisUrl!)
  await redis.flushdb()
  const app = createApp()
  app.use('/webhook', webhookHandler)
  server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Webhook test server did not bind')
  base = `http://127.0.0.1:${address.port}`
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://api.yookassa.ru/v3/')) {
      providerCalls++
      return new Response(JSON.stringify(providerResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return originalFetch(input, init)
  }
})

test.beforeEach(async () => {
  if (!isolated) return
  await redis!.flushdb()
  providerCalls = 0
  providerResponse = {}
})

test.after(async () => {
  if (!isolated) return
  await db.payment.deleteMany({ where: { id: { in: payments } } })
  await db.premiumSubscription.deleteMany({ where: { userId: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
  closePaymentWebhookRateLimitStore()
  redis?.disconnect()
  globalThis.fetch = originalFetch
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = previousRedisUrl
  if (previousTrustedProxyIps === undefined) delete process.env.PHONE_TRUSTED_PROXY_IPS
  else process.env.PHONE_TRUSTED_PROXY_IPS = previousTrustedProxyIps
  if (previousShopId === undefined) delete process.env.YOOKASSA_SHOP_ID
  else process.env.YOOKASSA_SHOP_ID = previousShopId
  if (previousSecretKey === undefined) delete process.env.YOOKASSA_SECRET_KEY
  else process.env.YOOKASSA_SECRET_KEY = previousSecretKey
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
})

async function account(prefix: string) {
  const result = await registerUser({ username: `${prefix}_${randomUUID().slice(0, 12)}`, password: 'Webhook-test-password-2026' })
  users.push(result.user.id)
  return result
}

async function payment(userId: string, type: 'PREMIUM' | 'VIRTUAL_CURRENCY' = 'VIRTUAL_CURRENCY') {
  const id = randomUUID()
  const isPremium = type === 'PREMIUM'
  const row = await db.payment.create({
    data: {
      userId,
      yookassaPaymentId: `yk_webhook_${id}`,
      type,
      productKey: isPremium ? 'PRO' : 'chips-99',
      amount: isPremium ? '299.00' : '99.00',
      currency: 'RUB',
      status: 'PENDING',
      description: isPremium ? 'Webhook Premium test' : 'Webhook chips test',
      metadata: isPremium ? { plan: 'PRO' } : { packageId: 'chips-99' },
      returnUrl: 'https://pocker.test/payments/return',
      idempotencyKey: randomUUID()
    }
  })
  payments.push(row.id)
  return row
}

async function post(paymentId: string, extraHeaders: Record<string, string> = {}) {
  const response = await originalFetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ event: 'payment.succeeded', object: { id: paymentId, status: 'succeeded', paid: true, amount: { value: '0.01', currency: 'USD' } } })
  })
  const data = await response.json().catch(() => null)
  return { response, data }
}

test('payment transaction retry handles only bounded serialization conflicts', async () => {
  let attempts = 0
  const result = await retryPaymentTransaction(async () => {
    attempts++
    if (attempts < 3) throw { code: 'P2034' }
    return 'processed'
  }, { sleep: async () => {} })
  assert.equal(result, 'processed')
  assert.equal(attempts, 3)

  let nonSerializationAttempts = 0
  const nonSerializationError = { code: 'P2002' }
  await assert.rejects(() => retryPaymentTransaction(async () => {
    nonSerializationAttempts++
    throw nonSerializationError
  }, { sleep: async () => {} }), error => error === nonSerializationError)
  assert.equal(nonSerializationAttempts, 1)

  let exhaustedAttempts = 0
  const exhaustedError = { code: 'P2034' }
  await assert.rejects(() => retryPaymentTransaction(async () => {
    exhaustedAttempts++
    throw exhaustedError
  }, { sleep: async () => {} }), error => error === exhaustedError)
  assert.equal(exhaustedAttempts, PAYMENT_TRANSACTION_MAX_ATTEMPTS)
})

function succeededProvider(paymentId: string, amount: string, currency = 'RUB') {
  providerResponse = { id: paymentId, status: 'succeeded', paid: true, amount: { value: amount, currency }, metadata: {} }
}

test('payment webhook rate counters use Redis atomically and expire', { skip: !isolated }, async () => {
  const short = {
    paymentId: { requests: 2, windowMs: 80 },
    sourceIp: { requests: 10, windowMs: 80 },
    global: { requests: 10, windowMs: 80 }
  } as const
  await redis!.flushdb()
  assert.equal((await consumePaymentWebhookCounters('payment-a', '198.51.100.10', short)).allowed, true)
  assert.equal((await consumePaymentWebhookCounters('payment-a', '198.51.100.10', short)).allowed, true)
  assert.equal((await consumePaymentWebhookCounters('payment-a', '198.51.100.10', short)).allowed, false)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal((await consumePaymentWebhookCounters('payment-a', '198.51.100.10', short)).allowed, true)
})

test('normal webhook verifies YooKassa and credits virtual currency once', { skip: !isolated }, async () => {
  const row = await account('webhook_normal')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '99.00')

  const result = await post(local.yookassaPaymentId!)
  assert.equal(result.response.status, 200)
  assert.equal(providerCalls, 1)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 14_900n)
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: local.id } })).status, 'PROCESSED')
})

test('normal provider retry is allowed and already processed payment is idempotent', { skip: !isolated }, async () => {
  const row = await account('webhook_retry')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '99.00')

  const first = await post(local.yookassaPaymentId!)
  const second = await post(local.yookassaPaymentId!)
  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.equal(second.data?.duplicate, true)
  assert.equal(providerCalls, 2)
  assert.equal((await db.walletLedgerEntry.count({ where: { idempotencyKey: `payment:${local.id}:wallet` } })), 1)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 14_900n)
})

test('concurrent duplicate virtual currency webhooks credit chips and ledger once', { skip: !isolated }, async () => {
  const row = await account('chips_concurrent')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '99.00')

  const results = await Promise.all(Array.from({ length: 4 }, () => post(local.yookassaPaymentId!)))
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 200, 200, 200])
  assert.equal(providerCalls, 4)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 14_900n)
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: local.id } })).status, 'PROCESSED')
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `payment:${local.id}:wallet` } }), 1)
})

test('duplicate payment result does not send duplicate notifications', async () => {
  const adminMessages: string[] = []
  const userMessages: string[] = []
  const local = { userId: 'user-1', type: 'VIRTUAL_CURRENCY', amount: { toString: () => '99.00' }, currency: 'RUB' }
  const dependencies = {
    notifyAdmin: async (_category: string, text: string) => { adminMessages.push(text); return true },
    dispatchUser: (_userId: string, _category: string, text: string) => { userMessages.push(text) }
  }

  await notifyPaymentResult({ duplicate: true, status: 'PROCESSED' }, local, dependencies)
  assert.deepEqual(adminMessages, [])
  assert.deepEqual(userMessages, [])

  await notifyPaymentResult({ duplicate: false, status: 'PROCESSED' }, local, dependencies)
  assert.equal(adminMessages.length, 1)
  assert.equal(userMessages.length, 1)
})

test('mass webhook requests are limited before YooKassa and forwarded header spoofing does not change source', { skip: !isolated }, async () => {
  const row = await account('webhook_limit')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '99.00')

  for (let index = 0; index < PAYMENT_WEBHOOK_RATE_LIMITS.paymentId.requests; index++) {
    const result = await post(local.yookassaPaymentId!, { 'x-forwarded-for': `198.51.100.${index + 1}`, 'x-real-ip': `203.0.113.${index + 1}` })
    assert.equal(result.response.status, 200)
  }
  const limited = await post(local.yookassaPaymentId!, { 'x-forwarded-for': '198.51.100.250', 'x-real-ip': '203.0.113.250' })
  assert.equal(limited.response.status, 429)
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0)
  assert.equal(providerCalls, PAYMENT_WEBHOOK_RATE_LIMITS.paymentId.requests)
})

test('webhook body cannot credit without matching provider amount and currency', { skip: !isolated }, async () => {
  const row = await account('webhook_fake')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '98.00', 'USD')

  const result = await post(local.yookassaPaymentId!)
  assert.equal(result.response.status, 409)
  assert.equal(providerCalls, 1)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 5_000n)
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: local.id } })).status, 'PENDING')
})

test('provider pending status does not credit', { skip: !isolated }, async () => {
  const row = await account('webhook_pending')
  const local = await payment(row.user.id)
  providerResponse = { id: local.yookassaPaymentId, status: 'pending', paid: false, amount: { value: '99.00', currency: 'RUB' }, metadata: {} }

  const result = await post(local.yookassaPaymentId!)
  assert.equal(result.response.status, 200)
  assert.equal(result.data?.status, 'PENDING')
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 5_000n)
})

test('concurrent duplicate premium webhooks activate Premium once', { skip: !isolated }, async () => {
  const row = await account('webhook_concurrent')
  const local = await payment(row.user.id, 'PREMIUM')
  succeededProvider(local.yookassaPaymentId!, '299.00')

  const [first, second] = await Promise.all([post(local.yookassaPaymentId!), post(local.yookassaPaymentId!)])
  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.equal(providerCalls, 2)
  assert.equal(await db.premiumSubscription.count({ where: { userId: row.user.id, status: 'ACTIVE' } }), 1)
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: local.id } })).status, 'PROCESSED')
})

test('Redis outage fails closed before YooKassa', { skip: !isolated }, async () => {
  const row = await account('webhook_redis')
  const local = await payment(row.user.id)
  succeededProvider(local.yookassaPaymentId!, '99.00')
  const previousRedisUrl = process.env.REDIS_URL
  closePaymentWebhookRateLimitStore()
  process.env.REDIS_URL = 'redis://127.0.0.1:1/14'
  try {
    const result = await post(local.yookassaPaymentId!)
    assert.equal(result.response.status, 503)
    assert.equal(providerCalls, 0)
    assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: row.user.id } })).balance, 5_000n)
  } finally {
    closePaymentWebhookRateLimitStore()
    process.env.REDIS_URL = previousRedisUrl
  }
})
