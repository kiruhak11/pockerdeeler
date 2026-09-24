import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { acceptCurrentLegalDocuments } from '../server/services/legalService'
import { createYooKassaPayment, paymentHistory, syncAndProcessPayment } from '../server/services/paymentService'
import { PREMIUM_PAYMENT_PLANS } from '../server/services/paymentCatalog'
import { getPremiumAccess, premiumExpiresAt } from '../server/services/premiumService'
import { legalAcceptanceBodySchema } from '../server/utils/legalAcceptanceSchema'

const premiumConfirmations = { termsAccepted: true }

test('Premium legal API schema rejects tariff, version, identity and payment spoof fields', () => {
  const base = { context: 'PREMIUM', checkout: true, plan: 'LITE', termsAccepted: true }
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, documentVersion: '9.9' }).success, false)
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, userId: '00000000-0000-0000-0000-000000000000' }).success, false)
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, paymentId: 'foreign-payment' }).success, false)
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, plan: 'PRO', documentVersion: '9.9' }).success, false)
})

test('Premium legal checkout binds the tariff and gates payment creation', { skip: !process.env.DATABASE_URL }, async t => {
  const db = new PrismaClient()
  const users: string[] = []
  const previousAppUrl = process.env.NUXT_PUBLIC_APP_URL
  const previousShopId = process.env.YOOKASSA_SHOP_ID
  const previousSecret = process.env.YOOKASSA_SECRET_KEY
  const previousFetch = globalThis.fetch
  let providerCalls = 0
  let providerMode: 'pending' | 'succeed' = 'pending'
  let syncPayment: { providerId: string; localId: string; amount: number; userId: string } | null = null
  process.env.NUXT_PUBLIC_APP_URL = 'http://localhost:3000'
  process.env.YOOKASSA_SHOP_ID = '1468251'
  process.env.YOOKASSA_SECRET_KEY = 'test-key'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (providerMode === 'succeed' && init?.method !== 'POST' && syncPayment) {
      return new Response(JSON.stringify({ id: syncPayment.providerId, status: 'succeeded', paid: true, amount: { value: syncPayment.amount.toFixed(2), currency: 'RUB' }, metadata: { internalPaymentId: syncPayment.localId, userId: syncPayment.userId, type: 'PREMIUM' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    providerCalls += 1
    const body = JSON.parse(String(init?.body || '{}')) as { amount?: { value?: string; currency?: string } }
    return new Response(JSON.stringify({ id: `premium_yk_${providerCalls}`, status: 'pending', paid: false, amount: body.amount, confirmation: { confirmation_url: `https://yookassa.test/premium_${providerCalls}` }, metadata: {}, created_at: new Date().toISOString() }), { status: 201, headers: { 'content-type': 'application/json' } })
  }

  async function user(label: string) {
    const row = await db.user.create({ data: { username: `premium_legal_${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`, passwordHash: 'test' } })
    users.push(row.id)
    return row
  }
  async function accept(userId: string, plan: keyof typeof PREMIUM_PAYMENT_PLANS = 'PRO', checkout = true) {
    return acceptCurrentLegalDocuments({ userId, context: 'PREMIUM', confirmations: premiumConfirmations, productKey: checkout ? plan : undefined, checkout, ip: '127.0.0.1', userAgent: 'premium-legal-test' })
  }
  async function createPayment(userId: string, requestId: string, plan: keyof typeof PREMIUM_PAYMENT_PLANS = 'PRO', priceRub = PREMIUM_PAYMENT_PLANS[plan].priceRub) {
    return createYooKassaPayment({ userId, type: 'PREMIUM', productKey: plan, priceRub, legalContext: 'PREMIUM', requestId, metadata: { userId, type: 'PREMIUM', plan } })
  }
  async function missingOffer(title: string) {
    await t.test(`without PUBLIC_OFFER ${title}`, async () => {
      const row = await user(`missing-${title}`)
      const checkout = await accept(row.id, 'LITE')
      await db.legalAcceptance.deleteMany({ where: { userId: row.id, requestId: checkout.requestId, document: { type: 'PUBLIC_OFFER' } } })
      await assert.rejects(() => createPayment(row.id, checkout.requestId, 'LITE'), error => error?.statusCode === 409)
      assert.equal(await db.payment.count({ where: { userId: row.id } }), 0)
    })
  }

  try {
    for (const plan of ['LITE', 'PRO', 'ELITE'] as const) {
      await t.test(`valid ${plan} checkout creates payment`, async () => {
        const row = await user(`valid-${plan}`)
        const checkout = await accept(row.id, plan)
        const session = await db.legalCheckoutSession.findUnique({ where: { id: checkout.requestId } })
        assert.equal(session?.context, 'PREMIUM')
        assert.equal(session?.paymentType, 'PREMIUM')
        assert.equal(session?.productKey, plan)
        assert.equal(checkout.documents.length, 1)
        const bindings = await db.legalAcceptance.findMany({ where: { userId: row.id, requestId: checkout.requestId }, include: { document: true } })
        assert.equal(bindings.length, 1)
        assert.ok(bindings.every(binding => binding.documentId === binding.document.id && binding.version === binding.document.version && binding.contentHash === binding.document.contentHash))
        assert.equal(bindings[0]?.document.type, 'PUBLIC_OFFER')
        assert.equal(bindings[0]?.version, '1.0')
        const payment = await createPayment(row.id, checkout.requestId, plan)
        assert.equal(payment.status, 'PENDING')
        assert.equal(await db.payment.count({ where: { checkoutId: checkout.requestId } }), 1)
      })
    }
    await missingOffer('payment fails')
    await t.test('direct API payment bypass fails without checkout acceptance', async () => {
      const row = await user('bypass')
      await assert.rejects(() => createPayment(row.id, '00000000-0000-0000-0000-000000000000', 'PRO'), error => error?.statusCode === 409)
      assert.equal(await db.payment.count({ where: { userId: row.id } }), 0)
    })
    await t.test('outdated offer acceptance requires current acceptance', async () => {
      const row = await user('outdated')
      const checkout = await accept(row.id, 'PRO')
      await db.legalAcceptance.updateMany({ where: { userId: row.id, requestId: checkout.requestId, document: { type: 'PUBLIC_OFFER' } }, data: { version: '0.9' } })
      await assert.rejects(() => createPayment(row.id, checkout.requestId, 'PRO'), error => error?.statusCode === 409)
    })
    await t.test('foreign user cannot use another user checkout', async () => {
      const owner = await user('owner')
      const foreign = await user('foreign')
      const checkout = await accept(owner.id, 'PRO')
      await assert.rejects(() => createPayment(foreign.id, checkout.requestId, 'PRO'), error => error?.statusCode === 403)
    })
    await t.test('VIRTUAL_CHIPS checkout cannot be used for Premium', async () => {
      const row = await user('chips-context')
      const checkout = await acceptCurrentLegalDocuments({ userId: row.id, context: 'VIRTUAL_CHIPS', productKey: 'chips-99', confirmations: { termsAccepted: true, virtualChipsRulesAccepted: true, virtualCurrencyAcknowledged: true, ageConfirmed: true }, checkout: true, ip: '127.0.0.1', userAgent: 'premium-legal-test' })
      await assert.rejects(() => createPayment(row.id, checkout.requestId, 'PRO'), error => error?.statusCode === 409)
    })
    for (const target of ['PRO', 'ELITE'] as const) {
      await t.test(`Lite checkout cannot be changed to ${target}`, async () => {
        const row = await user(`lite-to-${target}`)
        const checkout = await accept(row.id, 'LITE')
        await assert.rejects(() => createPayment(row.id, checkout.requestId, target), error => error?.statusCode === 409)
      })
    }
    for (const plan of ['LITE', 'PRO', 'ELITE'] as const) {
      await t.test(`server price for ${plan} remains ${PREMIUM_PAYMENT_PLANS[plan].priceRub}`, async () => {
        const row = await user(`price-${plan}`)
        const checkout = await accept(row.id, plan)
        const payment = await createPayment(row.id, checkout.requestId, plan)
        const stored = await db.payment.findUnique({ where: { id: payment.id } })
        assert.equal(Number(stored?.amount), PREMIUM_PAYMENT_PLANS[plan].priceRub)
      })
    }
    await t.test('duplicate legal acceptance is idempotent', async () => {
      const row = await user('accept-retry')
      const first = await accept(row.id, 'PRO')
      const second = await acceptCurrentLegalDocuments({ userId: row.id, context: 'PREMIUM', productKey: 'PRO', confirmations: premiumConfirmations, requestId: first.requestId, checkout: true, ip: '127.0.0.1', userAgent: 'premium-legal-retry' })
      assert.equal(second.requestId, first.requestId)
      assert.equal(await db.legalAcceptance.count({ where: { userId: row.id, requestId: first.requestId } }), 1)
    })
    await t.test('duplicate payment create is idempotent', async () => {
      const row = await user('payment-retry')
      const checkout = await accept(row.id, 'PRO')
      const first = await createPayment(row.id, checkout.requestId, 'PRO')
      const second = await createPayment(row.id, checkout.requestId, 'PRO')
      assert.equal(second.reused, true)
      assert.equal(second.id, first.id)
    })
    await t.test('two Premium checkouts remain independent', async () => {
      const row = await user('parallel')
      const [lite, elite] = await Promise.all([accept(row.id, 'LITE'), accept(row.id, 'ELITE')])
      assert.notEqual(lite.requestId, elite.requestId)
      const sessions = await db.legalCheckoutSession.findMany({ where: { id: { in: [lite.requestId, elite.requestId] } } })
      assert.deepEqual(new Set(sessions.map(item => item.productKey)), new Set(['LITE', 'ELITE']))
    })
    await t.test('Premium and chips checkouts remain independent', async () => {
      const row = await user('mixed')
      const [premium, chips] = await Promise.all([accept(row.id, 'PRO'), acceptCurrentLegalDocuments({ userId: row.id, context: 'VIRTUAL_CHIPS', productKey: 'chips-199', confirmations: { termsAccepted: true, virtualChipsRulesAccepted: true, virtualCurrencyAcknowledged: true, ageConfirmed: true }, checkout: true, ip: '127.0.0.1', userAgent: 'premium-legal-test' })])
      assert.notEqual(premium.requestId, chips.requestId)
      assert.equal((await db.legalCheckoutSession.findUnique({ where: { id: premium.requestId } }))?.context, 'PREMIUM')
      assert.equal((await db.legalCheckoutSession.findUnique({ where: { id: chips.requestId } }))?.context, 'VIRTUAL_CHIPS')
    })
    await t.test('return URL and payment creation do not activate Premium', async () => {
      const row = await user('return-url')
      const checkout = await accept(row.id, 'ELITE')
      await createPayment(row.id, checkout.requestId, 'ELITE')
      assert.equal((await getPremiumAccess(row.id)).active, false)
    })
    await t.test('successful provider processing activates once and duplicate webhook is guarded', async () => {
      const row = await user('webhook')
      const checkout = await accept(row.id, 'PRO')
      const payment = await createPayment(row.id, checkout.requestId, 'PRO')
      const stored = await db.payment.findUniqueOrThrow({ where: { id: payment.id } })
      syncPayment = { providerId: stored.yookassaPaymentId!, localId: stored.id, amount: Number(stored.amount), userId: row.id }
      providerMode = 'succeed'
      const first = await syncAndProcessPayment(syncPayment.providerId)
      const second = await syncAndProcessPayment(syncPayment.providerId)
      assert.equal(first.status, 'PROCESSED')
      assert.equal(second.duplicate, true)
      assert.equal(await db.premiumSubscription.count({ where: { userId: row.id, status: 'ACTIVE' } }), 1)
    })
    await t.test('Premium duration remains 30 days and existing active subscription remains readable', async () => {
      const row = await user('existing')
      const startedAt = new Date(Date.now() - 86_400_000)
      await db.premiumSubscription.create({ data: { userId: row.id, plan: 'ELITE', status: 'ACTIVE', startedAt, expiresAt: premiumExpiresAt(startedAt) } })
      const access = await getPremiumAccess(row.id)
      assert.equal(access.plan, 'ELITE')
      assert.equal(premiumExpiresAt(startedAt).getTime() - startedAt.getTime(), 30 * 86_400_000)
    })
    await t.test('historical Premium payment remains readable', async () => {
      const row = await user('history')
      await db.payment.create({ data: { userId: row.id, type: 'PREMIUM', productKey: 'PRO', amount: '299.00', currency: 'RUB', status: 'PROCESSED', paidAt: new Date(), processedAt: new Date(), description: 'historical Premium', metadata: { plan: 'PRO' }, returnUrl: 'http://localhost:3000/payments/return', idempotencyKey: randomUUID() } })
      const history = await paymentHistory(row.id)
      assert.equal(history[0]?.item, 'Premium Pro')
      assert.equal(history[0]?.status, 'PROCESSED')
    })
  } finally {
    await db.payment.deleteMany({ where: { userId: { in: users } } })
    await db.premiumSubscription.deleteMany({ where: { userId: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
    await db.$disconnect()
    if (previousAppUrl === undefined) delete process.env.NUXT_PUBLIC_APP_URL; else process.env.NUXT_PUBLIC_APP_URL = previousAppUrl
    if (previousShopId === undefined) delete process.env.YOOKASSA_SHOP_ID; else process.env.YOOKASSA_SHOP_ID = previousShopId
    if (previousSecret === undefined) delete process.env.YOOKASSA_SECRET_KEY; else process.env.YOOKASSA_SECRET_KEY = previousSecret
    globalThis.fetch = previousFetch
  }
})
