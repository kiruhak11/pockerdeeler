import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { acceptCurrentLegalDocuments } from '../server/services/legalService'
import { bindCheckoutLegalAcceptance, createYooKassaPayment } from '../server/services/paymentService'

const premiumConfirmations = { termsAccepted: true }
const chipsConfirmations = { termsAccepted: true, virtualCurrencyAcknowledged: true, virtualChipsRulesAccepted: true, ageConfirmed: true }

async function acceptCheckout(userId: string, context: 'PREMIUM' | 'VIRTUAL_CHIPS') {
  return acceptCurrentLegalDocuments({ userId, context, confirmations: context === 'PREMIUM' ? premiumConfirmations : chipsConfirmations, checkout: true, ip: '127.0.0.1', userAgent: 'legal-payment-test' })
}

test('concurrent legal acceptance is idempotent and preserves request ownership', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const users: string[] = []
  async function createUser(label: string) {
    const row = await db.user.create({ data: { username: `legal_r_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`, passwordHash: 'test' } })
    users.push(row.id)
    return row
  }
  function twoPartyBarrier() {
    let arrivals = 0
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    return async () => {
      arrivals += 1
      if (arrivals === 2) open()
      await gate
    }
  }

  try {
    const owner = await createUser('owner')
    const other = await createUser('other')
    const requestId = randomUUID()
    const waitForSameAcceptance = twoPartyBarrier()
    const acceptSameRequest = async () => {
      await waitForSameAcceptance()
      return acceptCurrentLegalDocuments({ userId: owner.id, context: 'PREMIUM', confirmations: premiumConfirmations, requestId, ip: '127.0.0.1', userAgent: 'legal-acceptance-concurrency-test' })
    }
    const [first, retry] = await Promise.all([acceptSameRequest(), acceptSameRequest()])
    assert.equal(first.requestId, requestId)
    assert.equal(retry.requestId, requestId)
    const sameOwnerRows = await db.legalAcceptance.findMany({ where: { requestId } })
    assert.equal(sameOwnerRows.length, 1)
    assert.equal(sameOwnerRows[0]?.userId, owner.id)
    assert.equal(sameOwnerRows[0]?.documentId, first.documents[0]?.documentId)
    assert.equal(sameOwnerRows[0]?.acceptedAt.getTime(), first.acceptedAt?.getTime())

    const contestedRequestId = randomUUID()
    const waitForOwnershipRace = twoPartyBarrier()
    const attemptWithOwner = async (userId: string, context: 'PREMIUM' | 'PERSONAL_DATA', confirmations: typeof premiumConfirmations | { personalDataConsent: true }) => {
      await waitForOwnershipRace()
      return acceptCurrentLegalDocuments({ userId, context, confirmations, requestId: contestedRequestId, ip: '127.0.0.1', userAgent: 'legal-acceptance-ownership-race-test' })
    }
    const raced = await Promise.allSettled([
      attemptWithOwner(owner.id, 'PREMIUM', premiumConfirmations),
      attemptWithOwner(other.id, 'PERSONAL_DATA', { personalDataConsent: true })
    ])
    const accepted = raced.find(result => result.status === 'fulfilled')
    const rejected = raced.find(result => result.status === 'rejected')
    assert.ok(accepted && accepted.status === 'fulfilled')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.equal(rejected.reason?.statusCode, 409)
    const contestedRows = await db.legalAcceptance.findMany({ where: { requestId: contestedRequestId } })
    const acceptedUserId = accepted.value.context === 'PREMIUM' ? owner.id : other.id
    assert.equal(contestedRows.length, accepted.value.documents.length)
    assert.ok(contestedRows.every(row => row.userId === acceptedUserId && row.context === accepted.value.context))
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } })
    await db.$disconnect()
  }
})

test('deterministic legal checkout binding survives retries, parallel products, and ownership checks', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const suffix = Date.now()
  const user = await db.user.create({ data: { username: `legal_payment_${suffix}`, passwordHash: 'test' } })
  const otherUser = await db.user.create({ data: { username: `legal_payment_other_${suffix}`, passwordHash: 'test' } })
  const previousAppUrl = process.env.NUXT_PUBLIC_APP_URL
  const previousShopId = process.env.YOOKASSA_SHOP_ID
  const previousSecret = process.env.YOOKASSA_SECRET_KEY
  const previousFetch = globalThis.fetch
  const providerCalls: string[] = []
  process.env.NUXT_PUBLIC_APP_URL = 'http://localhost:3000'
  process.env.YOOKASSA_SHOP_ID = '1468251'
  process.env.YOOKASSA_SECRET_KEY = 'test-key'
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    const idempotencyKey = headers.get('Idempotence-Key') || 'missing'
    providerCalls.push(idempotencyKey)
    const body = JSON.parse(String(init?.body || '{}')) as { amount?: { value?: string; currency?: string } }
    return new Response(JSON.stringify({ id: `yk_${idempotencyKey}`, status: 'pending', paid: false, amount: body.amount, confirmation: { confirmation_url: `https://yookassa.test/${idempotencyKey}` }, metadata: {} }), { status: 201, headers: { 'content-type': 'application/json' } })
  }

  const createdPaymentIds: string[] = []
  try {
    const first = await acceptCheckout(user.id, 'PREMIUM')
    const firstAgain = await acceptCurrentLegalDocuments({ userId: user.id, context: 'PREMIUM', confirmations: premiumConfirmations, requestId: first.requestId, checkout: true, ip: '127.0.0.1', userAgent: 'legal-payment-test' })
    assert.equal(firstAgain.requestId, first.requestId)
    assert.equal(await db.legalAcceptance.count({ where: { requestId: first.requestId } }), first.documents.length)

    const payment = await createYooKassaPayment({ userId: user.id, type: 'PREMIUM', productKey: 'PRO', priceRub: 299, legalContext: 'PREMIUM', requestId: first.requestId, metadata: { userId: user.id, type: 'PREMIUM', plan: 'PRO' } })
    createdPaymentIds.push(payment.id)
    const paymentRetry = await createYooKassaPayment({ userId: user.id, type: 'PREMIUM', productKey: 'PRO', priceRub: 299, legalContext: 'PREMIUM', requestId: first.requestId, metadata: { userId: user.id, type: 'PREMIUM', plan: 'PRO' } })
    assert.equal(paymentRetry.reused, true)
    assert.equal(providerCalls.length, 1)
    const firstRows = await db.legalAcceptance.findMany({ where: { requestId: first.requestId } })
    assert.ok(firstRows.every(row => row.paymentId === `yk_${providerCalls[0]}` && row.orderId))

    const parallelPremium = await Promise.all([acceptCheckout(otherUser.id, 'PREMIUM'), acceptCheckout(otherUser.id, 'PREMIUM')])
    const parallelPremiumPayments = await Promise.all(parallelPremium.map((checkout, index) => {
      const plan = 'LITE'
      const priceRub = 149
      return createYooKassaPayment({ userId: otherUser.id, type: 'PREMIUM', productKey: plan, priceRub, legalContext: 'PREMIUM', requestId: checkout.requestId, metadata: { userId: otherUser.id, type: 'PREMIUM', plan } })
    }))
    createdPaymentIds.push(...parallelPremiumPayments.map(result => result.id))
    assert.equal(new Set(parallelPremiumPayments.map(result => result.id)).size, 2)
    assert.equal(await db.payment.count({ where: { userId: otherUser.id, checkoutId: { in: parallelPremium.map(checkout => checkout.requestId) } } }), 2)

    const [premiumCheckout, chipsCheckout] = await Promise.all([acceptCheckout(user.id, 'PREMIUM'), acceptCheckout(user.id, 'VIRTUAL_CHIPS')])
    const [premiumPayment, chipsPayment] = await Promise.all([
      createYooKassaPayment({ userId: user.id, type: 'PREMIUM', productKey: 'ELITE', priceRub: 499, legalContext: 'PREMIUM', requestId: premiumCheckout.requestId, metadata: { userId: user.id, type: 'PREMIUM', plan: 'ELITE' } }),
      createYooKassaPayment({ userId: user.id, type: 'VIRTUAL_CURRENCY', productKey: 'chips-99', priceRub: 99, legalContext: 'VIRTUAL_CHIPS', requestId: chipsCheckout.requestId, metadata: { userId: user.id, type: 'VIRTUAL_CURRENCY', packageId: 'chips-99' } })
    ])
    createdPaymentIds.push(premiumPayment.id, chipsPayment.id)
    assert.equal((await db.payment.findUnique({ where: { id: premiumPayment.id } }))?.type, 'PREMIUM')
    assert.equal((await db.payment.findUnique({ where: { id: chipsPayment.id } }))?.type, 'VIRTUAL_CURRENCY')
    assert.equal((await db.legalCheckoutSession.findUnique({ where: { id: chipsCheckout.requestId } }))?.context, 'VIRTUAL_CHIPS')

    const otherAttempt = await assert.rejects(() => acceptCurrentLegalDocuments({ userId: otherUser.id, context: 'PREMIUM', confirmations: premiumConfirmations, requestId: first.requestId, checkout: true, ip: '127.0.0.1', userAgent: 'other' }), error => error?.statusCode === 403)
    assert.equal(otherAttempt, undefined)
    await assert.rejects(() => createYooKassaPayment({ userId: user.id, type: 'VIRTUAL_CURRENCY', productKey: 'chips-99', priceRub: 99, legalContext: 'VIRTUAL_CHIPS', requestId: first.requestId, metadata: { userId: user.id, type: 'VIRTUAL_CURRENCY', packageId: 'chips-99' } }), error => error?.statusCode === 409)
    await assert.rejects(() => bindCheckoutLegalAcceptance({ userId: otherUser.id, context: 'PREMIUM', requestId: parallelPremium[0].requestId, paymentId: `yk_${providerCalls[0]}`, orderId: 'foreign-order' }), error => error?.statusCode === 409)

    const standaloneRequestId = randomUUID()
    await acceptCurrentLegalDocuments({ userId: user.id, context: 'PREMIUM', confirmations: premiumConfirmations, requestId: standaloneRequestId, ip: '127.0.0.1', userAgent: 'standalone' })
    assert.equal(await db.legalAcceptance.count({ where: { requestId: standaloneRequestId } }), first.documents.length)
    await assert.rejects(() => createYooKassaPayment({ userId: user.id, type: 'PREMIUM', productKey: 'PRO', priceRub: 299, legalContext: 'PREMIUM', requestId: standaloneRequestId, metadata: { userId: user.id, type: 'PREMIUM', plan: 'PRO' } }), error => error?.statusCode === 409)
    await assert.rejects(() => createYooKassaPayment({ userId: user.id, type: 'PREMIUM', productKey: 'PRO', priceRub: 299, legalContext: 'PREMIUM', requestId: randomUUID(), metadata: { userId: user.id, type: 'PREMIUM', plan: 'PRO' } }), error => error?.statusCode === 409)
  } finally {
    if (previousAppUrl === undefined) delete process.env.NUXT_PUBLIC_APP_URL; else process.env.NUXT_PUBLIC_APP_URL = previousAppUrl
    if (previousShopId === undefined) delete process.env.YOOKASSA_SHOP_ID; else process.env.YOOKASSA_SHOP_ID = previousShopId
    if (previousSecret === undefined) delete process.env.YOOKASSA_SECRET_KEY; else process.env.YOOKASSA_SECRET_KEY = previousSecret
    globalThis.fetch = previousFetch
    await db.payment.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } })
    await db.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } })
    await db.$disconnect()
  }
})
