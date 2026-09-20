import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { acceptCurrentLegalDocuments, assertLegalConfirmations } from '../server/services/legalService'
import { createYooKassaPayment, paymentHistory } from '../server/services/paymentService'
import { VIRTUAL_CURRENCY_PACKAGES } from '../server/services/paymentCatalog'
import { legalAcceptanceBodySchema } from '../server/utils/legalAcceptanceSchema'

const chipsConfirmations = {
  termsAccepted: true,
  virtualChipsRulesAccepted: true,
  virtualCurrencyAcknowledged: true,
  ageConfirmed: true
}

test('virtual chips legal confirmation requires every client-visible checkbox', () => {
  assert.throws(() => assertLegalConfirmations('VIRTUAL_CHIPS', { termsAccepted: true, virtualCurrencyAcknowledged: true, ageConfirmed: true }))
  assert.doesNotThrow(() => assertLegalConfirmations('VIRTUAL_CHIPS', chipsConfirmations))
})

test('virtual chips legal API schema rejects consent and identity spoof fields', () => {
  const base = { context: 'VIRTUAL_CHIPS', checkout: true, packageId: 'chips-99', ...chipsConfirmations }
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, documentVersion: '9.9' }).success, false)
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, userId: '00000000-0000-0000-0000-000000000000' }).success, false)
  assert.equal(legalAcceptanceBodySchema.safeParse({ ...base, paymentId: 'foreign-payment' }).success, false)
})

test('virtual chips checkout gate and payment binding enforce the full server flow', { skip: !process.env.DATABASE_URL }, async t => {
  const db = new PrismaClient()
  const users: string[] = []
  const previousAppUrl = process.env.NUXT_PUBLIC_APP_URL
  const previousShopId = process.env.YOOKASSA_SHOP_ID
  const previousSecret = process.env.YOOKASSA_SECRET_KEY
  const previousFetch = globalThis.fetch
  let providerCalls = 0
  process.env.NUXT_PUBLIC_APP_URL = 'http://localhost:3000'
  process.env.YOOKASSA_SHOP_ID = '1468251'
  process.env.YOOKASSA_SECRET_KEY = 'test-key'
  globalThis.fetch = async (_input, init) => {
    providerCalls += 1
    const body = JSON.parse(String(init?.body || '{}')) as { amount?: { value?: string; currency?: string } }
    return new Response(JSON.stringify({ id: `chips_yk_${providerCalls}`, status: 'pending', paid: false, amount: body.amount, confirmation: { confirmation_url: `https://yookassa.test/chips_${providerCalls}` }, metadata: {} }), { status: 201, headers: { 'content-type': 'application/json' } })
  }

  async function user(label: string) {
    const row = await db.user.create({ data: { username: `chips_legal_${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`, passwordHash: 'test' } })
    users.push(row.id)
    return row
  }
  async function accept(userId: string, packageId = 'chips-199' as keyof typeof VIRTUAL_CURRENCY_PACKAGES, checkout = true) {
    return acceptCurrentLegalDocuments({ userId, context: 'VIRTUAL_CHIPS', confirmations: chipsConfirmations, productKey: checkout ? packageId : undefined, checkout, ip: '127.0.0.1', userAgent: 'chips-legal-test' })
  }
  async function createPayment(userId: string, requestId: string, packageId: keyof typeof VIRTUAL_CURRENCY_PACKAGES = 'chips-199', priceRub = VIRTUAL_CURRENCY_PACKAGES[packageId].priceRub) {
    return createYooKassaPayment({ userId, type: 'VIRTUAL_CURRENCY', productKey: packageId, priceRub, legalContext: 'VIRTUAL_CHIPS', requestId, metadata: { userId, type: 'VIRTUAL_CURRENCY', packageId } })
  }
  async function missingDocument(type: string, title: string) {
    await t.test(`without ${title} payment creation fails`, async () => {
      const row = await user(type.toLowerCase())
      const checkout = await accept(row.id)
      await db.legalAcceptance.deleteMany({ where: { userId: row.id, requestId: checkout.requestId, document: { type } } })
      await assert.rejects(() => createPayment(row.id, checkout.requestId), error => error?.statusCode === 409)
      assert.equal(await db.payment.count({ where: { userId: row.id } }), 0)
    })
  }

  try {
    await t.test('valid checkout creates one pending payment and binds the selected package', async () => {
      const row = await user('valid')
      const checkout = await accept(row.id, 'chips-99')
      const session = await db.legalCheckoutSession.findUnique({ where: { id: checkout.requestId } })
      assert.equal(session?.context, 'VIRTUAL_CHIPS')
      assert.equal(session?.paymentType, 'VIRTUAL_CURRENCY')
      assert.equal(session?.productKey, 'chips-99')
      assert.equal(checkout.documents.length, 5)
      const payment = await createPayment(row.id, checkout.requestId, 'chips-99')
      assert.equal(payment.status, 'PENDING')
      assert.equal(await db.payment.count({ where: { checkoutId: checkout.requestId } }), 1)
    })
    await missingDocument('PUBLIC_OFFER', 'PUBLIC_OFFER')
    await missingDocument('VIRTUAL_CHIPS_RULES', 'VIRTUAL_CHIPS_RULES')
    await missingDocument('GAME_RULES', 'GAME_RULES')
    await missingDocument('AGE_CONFIRMATION', 'AGE_CONFIRMATION')
    await missingDocument('VIRTUAL_CURRENCY_NOTICE', 'VIRTUAL_CURRENCY_NOTICE')

    await t.test('direct payment creation without checkout acceptance is rejected', async () => {
      const row = await user('bypass')
      await assert.rejects(() => createPayment(row.id, '00000000-0000-0000-0000-000000000000'), error => error?.statusCode === 409)
      assert.equal(await db.payment.count({ where: { userId: row.id } }), 0)
    })
    await t.test('outdated acceptance does not satisfy the current document version', async () => {
      const row = await user('outdated')
      const checkout = await accept(row.id)
      await db.legalAcceptance.updateMany({ where: { userId: row.id, requestId: checkout.requestId, document: { type: 'GAME_RULES' } }, data: { version: '0.9' } })
      await assert.rejects(() => createPayment(row.id, checkout.requestId), error => error?.statusCode === 409)
    })
    await t.test('foreign user cannot use another user checkout', async () => {
      const owner = await user('owner')
      const foreign = await user('foreign')
      const checkout = await accept(owner.id)
      await assert.rejects(() => createPayment(foreign.id, checkout.requestId), error => error?.statusCode === 403)
    })
    await t.test('Premium checkout cannot be used for chips payment', async () => {
      const row = await user('premium-context')
      const checkout = await acceptCurrentLegalDocuments({ userId: row.id, context: 'PREMIUM', confirmations: { termsAccepted: true }, checkout: true, ip: '127.0.0.1', userAgent: 'chips-legal-test' })
      await assert.rejects(() => createPayment(row.id, checkout.requestId), error => error?.statusCode === 409)
    })
    await t.test('standalone acceptance is insufficient for a checkout payment', async () => {
      const row = await user('standalone')
      const acceptance = await accept(row.id, 'chips-199', false)
      await assert.rejects(() => createPayment(row.id, acceptance.requestId), error => error?.statusCode === 409)
    })
    await t.test('duplicate legal acceptance is idempotent', async () => {
      const row = await user('accept-retry')
      const first = await accept(row.id, 'chips-499')
      const second = await acceptCurrentLegalDocuments({ userId: row.id, context: 'VIRTUAL_CHIPS', confirmations: chipsConfirmations, productKey: 'chips-499', requestId: first.requestId, checkout: true, ip: '127.0.0.1', userAgent: 'chips-legal-test-retry' })
      assert.equal(second.requestId, first.requestId)
      assert.equal(await db.legalAcceptance.count({ where: { userId: row.id, requestId: first.requestId } }), 5)
    })
    await t.test('duplicate payment creation reuses one provider payment', async () => {
      const row = await user('payment-retry')
      const checkout = await accept(row.id)
      const first = await createPayment(row.id, checkout.requestId)
      const second = await createPayment(row.id, checkout.requestId)
      assert.equal(second.reused, true)
      assert.equal(second.id, first.id)
      assert.equal(await db.payment.count({ where: { userId: row.id } }), 1)
    })
    await t.test('two parallel chips checkouts remain independent', async () => {
      const row = await user('parallel')
      const [first, second] = await Promise.all([accept(row.id, 'chips-99'), accept(row.id, 'chips-999')])
      assert.notEqual(first.requestId, second.requestId)
      const sessions = await db.legalCheckoutSession.findMany({ where: { id: { in: [first.requestId, second.requestId] } } })
      assert.deepEqual(new Set(sessions.map(item => item.productKey)), new Set(['chips-99', 'chips-999']))
    })
    await t.test('chips and Premium checkouts remain independent', async () => {
      const row = await user('mixed')
      const [chips, premium] = await Promise.all([
        accept(row.id, 'chips-199'),
        acceptCurrentLegalDocuments({ userId: row.id, context: 'PREMIUM', confirmations: { termsAccepted: true }, checkout: true, ip: '127.0.0.1', userAgent: 'chips-legal-test' })
      ])
      assert.notEqual(chips.requestId, premium.requestId)
      assert.equal((await db.legalCheckoutSession.findUnique({ where: { id: chips.requestId } }))?.context, 'VIRTUAL_CHIPS')
      assert.equal((await db.legalCheckoutSession.findUnique({ where: { id: premium.requestId } }))?.context, 'PREMIUM')
    })
    await t.test('package substitution is rejected by the bound checkout', async () => {
      const row = await user('package-substitution')
      const checkout = await accept(row.id, 'chips-99')
      await assert.rejects(() => createPayment(row.id, checkout.requestId, 'chips-199'), error => error?.statusCode === 409)
    })
    await t.test('server catalog rejects forged price', async () => {
      const row = await user('price-spoof')
      const checkout = await accept(row.id, 'chips-99')
      await assert.rejects(() => createPayment(row.id, checkout.requestId, 'chips-99', 999), error => error?.statusCode === 409)
    })
    await t.test('pending payment and return URL do not credit the wallet', async () => {
      const row = await user('return-url')
      const checkout = await accept(row.id)
      const payment = await createPayment(row.id, checkout.requestId)
      assert.equal(payment.status, 'PENDING')
      assert.equal(await db.userWallet.findUnique({ where: { userId: row.id } }), null)
    })
    await t.test('historical payment rows remain readable', async () => {
      const row = await user('history')
      await db.payment.create({ data: { userId: row.id, type: 'VIRTUAL_CURRENCY', productKey: 'chips-99', amount: '99.00', currency: 'RUB', status: 'PROCESSED', paidAt: new Date(), processedAt: new Date(), description: 'historical chips', metadata: { packageId: 'chips-99' }, returnUrl: 'http://localhost:3000/payments/return', idempotencyKey: randomUUID() } })
      const history = await paymentHistory(row.id)
      assert.equal(history.length, 1)
      assert.equal(history[0]?.chips, 9900)
      assert.equal(history[0]?.status, 'PROCESSED')
    })
    assert.equal(providerCalls > 0, true)
  } finally {
    await db.payment.deleteMany({ where: { userId: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
    await db.$disconnect()
    if (previousAppUrl === undefined) delete process.env.NUXT_PUBLIC_APP_URL; else process.env.NUXT_PUBLIC_APP_URL = previousAppUrl
    if (previousShopId === undefined) delete process.env.YOOKASSA_SHOP_ID; else process.env.YOOKASSA_SHOP_ID = previousShopId
    if (previousSecret === undefined) delete process.env.YOOKASSA_SECRET_KEY; else process.env.YOOKASSA_SECRET_KEY = previousSecret
    globalThis.fetch = previousFetch
  }
})
