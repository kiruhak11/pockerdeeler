import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { prisma } from '../server/db/client'
import { enqueueExpiredPremiumEvents, premiumExpirationEventKey, seasonFinishedEventKey, seasonStartedEventKey } from '../server/services/telegramLifecycleService'
import { ensureCurrentSeason, finalizeSeason } from '../server/services/seasonService'
import { deliverTelegramUserEvents, notifyUserTelegram } from '../server/services/notificationService'

test('Premium expiration event has one deterministic idempotency key', () => {
  assert.equal(premiumExpirationEventKey('subscription-1'), premiumExpirationEventKey('subscription-1'))
})

test('season transition event keys are distinct and deterministic', () => {
  assert.equal(seasonFinishedEventKey('season-1', 'user-1'), seasonFinishedEventKey('season-1', 'user-1'))
  assert.notEqual(seasonFinishedEventKey('season-1', 'user-1'), seasonStartedEventKey('season-2', 'user-1'))
})

test('disabled Premium category blocks delivery', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const user = await db.user.create({ data: { username: `disabled_${Date.now()}`, passwordHash: 'test' } })
  await db.telegramNotificationSettings.create({ data: { userId: user.id, settings: { premium: false } } })
  const previous = process.env.TELEGRAM_BOT_TOKEN
  process.env.TELEGRAM_BOT_TOKEN = ''
  try { assert.equal(await notifyUserTelegram(user.id, 'premium', 'test'), false) }
  finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previous
    await db.user.delete({ where: { id: user.id } })
    await db.$disconnect()
  }
})

test('expired Premium is queued once in PostgreSQL', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const user = await db.user.create({ data: { username: `lifecycle_${Date.now()}`, passwordHash: 'test' } })
  const subscription = await db.premiumSubscription.create({ data: { userId: user.id, plan: 'ELITE', startedAt: new Date(Date.now() - 31 * 86400000), expiresAt: new Date(Date.now() - 1000), status: 'ACTIVE' } })
  await db.telegramSubscription.create({ data: { userId: user.id, chatId: `lifecycle-${Date.now()}`, telegramUserId: `lifecycle-${Date.now()}` } })
  const previousToken = process.env.TELEGRAM_BOT_TOKEN
  const previousFetch = globalThis.fetch
  let sent = 0
  process.env.TELEGRAM_BOT_TOKEN = 'test-lifecycle-token'
  globalThis.fetch = async () => {
    sent++
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await enqueueExpiredPremiumEvents()
    await enqueueExpiredPremiumEvents()
    await deliverTelegramUserEvents()
    await deliverTelegramUserEvents()
    assert.equal(await db.telegramUserEvent.count({ where: { eventKey: premiumExpirationEventKey(subscription.id) } }), 1)
    assert.equal(sent, 1)
  } finally {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken
    globalThis.fetch = previousFetch
    await db.user.delete({ where: { id: user.id } })
    await db.$disconnect()
  }
})

test('season finalization queues one finish and one start event for each user', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const user = await db.user.create({ data: { username: `season_lifecycle_${Date.now()}`, passwordHash: 'test' } })
  await db.userWallet.create({ data: { userId: user.id, balance: 50_000n } })
  const preexistingSeason = await db.season.findFirst({ where: { status: 'active' }, orderBy: { number: 'desc' }, select: { number: true } })
  let fixtureSeasonNumber: number | undefined
  const originalTransaction = prisma.$transaction.bind(prisma)
  class RollbackSeasonFinalization extends Error {
    constructor(readonly result: Awaited<ReturnType<typeof finalizeSeason>>) {
      super('Rollback test-only season finalization')
    }
  }

  try {
    const current = await ensureCurrentSeason()
    if (!preexistingSeason) fixtureSeasonNumber = current.number

    ;(prisma as any).$transaction = (operation: any, options?: any) => originalTransaction(async tx => {
      const result = await operation(tx)
      const events = await tx.telegramUserEvent.findMany({ where: { userId: user.id }, orderBy: { eventKey: 'asc' } })
      assert.equal(result.seasonNumber, current.number)
      assert.equal(events.length, 2)
      assert.deepEqual(events.map(event => event.category), ['seasons', 'seasons'])
      assert.equal(new Set(events.map(event => event.eventKey)).size, 2)
      assert.match(events.map(event => event.text).join('\n'), /завершён|Начался новый сезон/)
      throw new RollbackSeasonFinalization(result)
    }, options)

    let result: Awaited<ReturnType<typeof finalizeSeason>> | undefined
    try {
      await finalizeSeason()
      assert.fail('The test transaction should roll back after verifying queued events.')
    } catch (error) {
      if (!(error instanceof RollbackSeasonFinalization)) throw error
      result = error.result
    }
    assert.ok(result)
    assert.equal(result.seasonNumber, current.number)
  } finally {
    ;(prisma as any).$transaction = originalTransaction
    await db.user.delete({ where: { id: user.id } })
    if (fixtureSeasonNumber !== undefined) await db.season.deleteMany({ where: { number: fixtureSeasonNumber } })
    await db.$disconnect()
  }
})
