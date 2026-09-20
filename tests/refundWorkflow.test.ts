import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import test from 'node:test'
import { acceptCurrentLegalDocuments, legalContentHash } from '../server/services/legalService'
import { bindCheckoutLegalAcceptance, paymentHistory } from '../server/services/paymentService'
import { requestRefund, getRefundEligibility } from '../server/services/refundService'
import { evaluateRefundEligibility } from '../server/utils/refundEligibility'
import { refundRequestBodySchema } from '../server/utils/refundRequestSchema'

test('refund API ignores status, ownership and purchase type spoof fields', () => {
  const parsed = refundRequestBodySchema.safeParse({ paymentId: randomUUID(), reason: 'Тестовая причина', status: 'REFUNDED', userId: randomUUID(), purchaseType: 'PREMIUM' })
  assert.equal(parsed.success, false)
})

test('Premium refund server policy stays review-based and chips stay provenance-safe', () => {
  const now = new Date('2026-09-20T00:00:00.000Z')
  const payment = { type: 'PREMIUM', status: 'PROCESSED', paidAt: new Date(now.getTime() - 6 * 86_400_000), processedAt: now, createdAt: now, refundStatus: null }
  assert.equal(evaluateRefundEligibility(payment, now), 'AVAILABLE')
  assert.equal(evaluateRefundEligibility({ ...payment, paidAt: new Date(now.getTime() - 7 * 86_400_000) }, now), 'AVAILABLE')
  assert.equal(evaluateRefundEligibility({ ...payment, paidAt: new Date(now.getTime() - 8 * 86_400_000) }, now), 'MANUAL_REVIEW_REQUIRED')
  assert.equal(evaluateRefundEligibility({ ...payment, type: 'VIRTUAL_CURRENCY' }, now), 'USAGE_UNVERIFIABLE')
})

test('refund workflow preserves ownership, legal evidence, and notification idempotency', { skip: !process.env.DATABASE_URL }, async t => {
  const db = new PrismaClient()
  const userIds: string[] = []
  const paymentIds: string[] = []
  const legalDocumentIds: string[] = []
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const previousToken = process.env.TELEGRAM_BOT_TOKEN
  const previousFetch = globalThis.fetch
  const messages: { chat_id?: string | number; text?: string }[] = []
  process.env.TELEGRAM_BOT_TOKEN = 'refund-test-token'
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string }
    messages.push(body)
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  async function createUser(label: string, role = 'USER') {
    const user = await db.user.create({ data: { username: `refund_${label}_${suffix}`, passwordHash: 'test', role } })
    userIds.push(user.id)
    return user
  }

  async function createPayment(userId: string, type: 'PREMIUM' | 'VIRTUAL_CURRENCY' = 'PREMIUM', createdAt = new Date()) {
    const premium = type === 'PREMIUM'
    const payment = await db.payment.create({
      data: {
        userId,
        type,
        productKey: premium ? 'LITE' : 'chips-99',
        amount: premium ? '149.00' : '99.00',
        currency: 'RUB',
        status: 'PROCESSED',
        description: premium ? 'Premium Lite' : 'Virtual chips',
        metadata: premium ? { plan: 'LITE' } : { packageId: 'chips-99' },
        returnUrl: 'http://localhost:3000/payments/return',
        idempotencyKey: randomUUID(),
        paidAt: createdAt,
        processedAt: createdAt,
        createdAt
      }
    })
    paymentIds.push(payment.id)
    return payment
  }

  async function waitForNotifications() {
    await new Promise(resolve => setTimeout(resolve, 80))
  }

  try {
    await t.test('own Premium payment eligibility is server-side', async () => {
      const user = await createUser('eligibility-owner')
      const payment = await createPayment(user.id)
      const result = await getRefundEligibility(user.id, payment.id)
      assert.equal(result.eligible, true)
      assert.equal(result.code, 'AVAILABLE')
    })

    await t.test('foreign payment eligibility is denied', async () => {
      const owner = await createUser('eligibility-foreign-owner')
      const foreign = await createUser('eligibility-foreign')
      const payment = await createPayment(owner.id)
      await assert.rejects(() => getRefundEligibility(foreign.id, payment.id), error => error?.statusCode === 404)
    })

    await t.test('valid refund request is REQUESTED', async () => {
      const user = await createUser('valid-request')
      const payment = await createPayment(user.id)
      const request = await requestRefund(user.id, payment.id, 'Ошибка предоставления Premium')
      assert.equal(request.status, 'REQUESTED')
      assert.equal(request.paymentId, payment.id)
    })

    await t.test('duplicate sequential POST returns one request', async () => {
      const user = await createUser('duplicate-sequential')
      const payment = await createPayment(user.id)
      const first = await requestRefund(user.id, payment.id, 'Нужно проверить покупку')
      const second = await requestRefund(user.id, payment.id, 'Повторная отправка запроса')
      assert.equal(second.id, first.id)
      assert.equal(await db.refundRequest.count({ where: { paymentId: payment.id } }), 1)
    })

    await t.test('parallel refund requests produce one result', async () => {
      const user = await createUser('duplicate-parallel')
      const payment = await createPayment(user.id)
      const results = await Promise.all([requestRefund(user.id, payment.id, 'Параллельный запрос один'), requestRefund(user.id, payment.id, 'Параллельный запрос два')])
      assert.equal(new Set(results.map(result => result.id)).size, 1)
      assert.equal(await db.refundRequest.count({ where: { paymentId: payment.id } }), 1)
    })

    await t.test('nonexistent payment fails', async () => {
      const user = await createUser('missing-payment')
      await assert.rejects(() => requestRefund(user.id, randomUUID(), 'Платеж не найден'), error => error?.statusCode === 404)
    })

    await t.test('foreign paymentId cannot create a request', async () => {
      const owner = await createUser('request-foreign-owner')
      const foreign = await createUser('request-foreign')
      const payment = await createPayment(owner.id)
      await assert.rejects(() => requestRefund(foreign.id, payment.id, 'Чужой платеж'), error => error?.statusCode === 404)
      assert.equal(await db.refundRequest.count({ where: { paymentId: payment.id } }), 0)
    })

    await t.test('Premium after standard window remains requestable for manual review', async () => {
      const user = await createUser('expired')
      const payment = await createPayment(user.id, 'PREMIUM', new Date(Date.now() - 8 * 86_400_000))
      const result = await getRefundEligibility(user.id, payment.id)
      assert.equal(result.eligible, true)
      assert.equal(result.code, 'MANUAL_REVIEW_REQUIRED')
      const request = await requestRefund(user.id, payment.id, 'Premium не был предоставлен после оплаты')
      assert.equal(request.status, 'REQUESTED')
      assert.equal((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, 'PROCESSED')
    })

    await t.test('virtual chips never use currentBalance as proof of non-use', async () => {
      const user = await createUser('chips-usage')
      const payment = await createPayment(user.id, 'VIRTUAL_CURRENCY')
      const result = await getRefundEligibility(user.id, payment.id)
      assert.equal(result.eligible, false)
      assert.equal(result.code, 'USAGE_UNVERIFIABLE')
    })

    await t.test('REQUESTED, APPROVED, REFUNDED and REJECTED stay single-request states', async () => {
      for (const status of ['REQUESTED', 'APPROVED', 'REFUNDED', 'REJECTED'] as const) {
        const user = await createUser(`status-${status.toLowerCase()}`)
        const payment = await createPayment(user.id)
        const existing = await db.refundRequest.create({ data: { id: randomUUID(), userId: user.id, paymentId: payment.id, purchaseType: payment.type, reason: 'Существующий запрос', status } })
        const returned = await requestRefund(user.id, payment.id, 'Повторный запрос')
        assert.equal(returned.id, existing.id)
        assert.equal(await db.refundRequest.count({ where: { paymentId: payment.id } }), 1)
      }
    })

    await t.test('Telegram failure does not roll back the request', async () => {
      globalThis.fetch = async () => { throw new Error('Telegram unavailable') }
      const user = await createUser('telegram-failure')
      const payment = await createPayment(user.id)
      const request = await requestRefund(user.id, payment.id, 'Telegram недоступен')
      await waitForNotifications()
      assert.equal(request.status, 'REQUESTED')
      assert.equal(await db.refundRequest.count({ where: { paymentId: payment.id } }), 1)
      globalThis.fetch = previousFetch
    })

    await t.test('user notification is sent once for a repeated request', async () => {
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string }
        messages.push(body)
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const user = await createUser('telegram-user')
      const chatId = `refund-user-${suffix}`
      await db.telegramSubscription.create({ data: { userId: user.id, chatId, telegramUserId: chatId } })
      const payment = await createPayment(user.id)
      messages.length = 0
      await requestRefund(user.id, payment.id, 'Проверка повтора уведомления')
      await requestRefund(user.id, payment.id, 'Проверка повтора уведомления еще раз')
      await waitForNotifications()
      assert.equal(messages.filter(message => message.chat_id === chatId).length, 1)
    })

    await t.test('admin notification is sent once for a repeated request', async () => {
      const admin = await createUser('telegram-admin', 'SUPERADMIN')
      const chatId = `refund-admin-${suffix}`
      await db.telegramSubscription.create({ data: { userId: admin.id, chatId, telegramUserId: chatId } })
      const user = await createUser('telegram-admin-owner')
      const payment = await createPayment(user.id)
      messages.length = 0
      await requestRefund(user.id, payment.id, 'Проверка админского уведомления')
      await requestRefund(user.id, payment.id, 'Проверка админского уведомления еще раз')
      await waitForNotifications()
      assert.equal(messages.filter(message => message.chat_id === chatId).length, 1)
    })

    await t.test('payment history remains user-owned and exposes refund state', async () => {
      const owner = await createUser('history-owner')
      const foreign = await createUser('history-foreign')
      const payment = await createPayment(owner.id)
      await requestRefund(owner.id, payment.id, 'Проверка истории покупки')
      const ownerHistory = await paymentHistory(owner.id)
      const foreignHistory = await paymentHistory(foreign.id)
      assert.equal(ownerHistory.length, 1)
      assert.equal(ownerHistory[0]?.refund?.status, 'REQUESTED')
      assert.equal(foreignHistory.length, 0)
    })

    await t.test('checkout acceptance stores historical legal evidence on the payment', async () => {
      const user = await createUser('legal-evidence')
      const checkout = await acceptCurrentLegalDocuments({ userId: user.id, context: 'PREMIUM', productKey: 'LITE', checkout: true, confirmations: { termsAccepted: true }, ip: '127.0.0.1', userAgent: 'refund-test' })
      const payment = await db.payment.create({ data: { userId: user.id, type: 'PREMIUM', productKey: 'LITE', amount: '149.00', currency: 'RUB', status: 'PROCESSED', providerStatus: 'succeeded', paidAt: new Date(), processedAt: new Date(), description: 'Historical Premium', metadata: { plan: 'LITE' }, returnUrl: 'http://localhost:3000/payments/return', idempotencyKey: randomUUID(), checkoutId: checkout.requestId, yookassaPaymentId: `yk_refund_${suffix}` } })
      paymentIds.push(payment.id)
      await bindCheckoutLegalAcceptance({ userId: user.id, context: 'PREMIUM', requestId: checkout.requestId, paymentId: payment.yookassaPaymentId!, orderId: payment.orderId })
      const acceptance = await db.legalAcceptance.findFirstOrThrow({ where: { requestId: checkout.requestId, context: 'PREMIUM' }, include: { document: true } })
      assert.equal(acceptance.version, '1.0')
      assert.equal(acceptance.paymentId, payment.yookassaPaymentId)
      assert.equal(acceptance.contentHash, acceptance.document.contentHash)
    })

    await t.test('new legal document version does not rewrite old acceptance', async () => {
      const user = await createUser('legal-version')
      const checkout = await acceptCurrentLegalDocuments({ userId: user.id, context: 'PREMIUM', productKey: 'PRO', checkout: true, confirmations: { termsAccepted: true }, ip: '127.0.0.1', userAgent: 'refund-test' })
      const before = await db.legalAcceptance.findFirstOrThrow({ where: { requestId: checkout.requestId, context: 'PREMIUM' } })
      const source = await db.legalDocument.findFirstOrThrow({ where: { type: 'PUBLIC_OFFER', version: '1.0' } })
      const revised = await db.legalDocument.create({ data: { type: 'PUBLIC_OFFER', version: '1.1', title: source.title, content: `${source.content} revised`, contentPath: source.contentPath, contentHash: legalContentHash(`${source.content} revised`), effectiveFrom: new Date('2027-01-01T00:00:00.000Z'), publishedAt: new Date('2027-01-01T00:00:00.000Z'), isActive: false } })
      legalDocumentIds.push(revised.id)
      const after = await db.legalAcceptance.findFirstOrThrow({ where: { requestId: checkout.requestId, context: 'PREMIUM' } })
      assert.equal(after.id, before.id)
      assert.equal(after.version, '1.0')
      assert.equal(after.contentHash, before.contentHash)
    })

    await t.test('request does not mutate payment status or perform provider refund', async () => {
      const user = await createUser('no-provider-refund')
      const payment = await createPayment(user.id)
      await requestRefund(user.id, payment.id, 'Провайдерский возврат не выполняется')
      const stored = await db.payment.findUniqueOrThrow({ where: { id: payment.id } })
      assert.equal(stored.status, 'PROCESSED')
      assert.equal(stored.providerStatus, null)
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken
    await db.refundRequest.deleteMany({ where: { userId: { in: userIds } } })
    await db.legalAcceptance.deleteMany({ where: { userId: { in: userIds } } })
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } })
    await db.legalCheckoutSession.deleteMany({ where: { userId: { in: userIds } } })
    await db.legalDocument.deleteMany({ where: { id: { in: legalDocumentIds } } })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
    await db.$disconnect()
  }
})
