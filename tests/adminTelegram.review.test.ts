import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../server/db/client'
import { ensureAchievementDefinitions, unlockAchievement } from '../server/services/achievementService'
import { deliverAchievementNotifications } from '../server/services/achievementNotificationService'
import { createTelegramLink, handleTelegramUpdate, unlinkTelegram, telegramStatus, notifyTelegram } from '../server/services/telegramService'
import { issueUserAuthToken, hashPassword } from '../server/services/userAccountService'
import { adminMiniGameResetCommand, adminAchievementCommand, adminUserDetail } from '../server/services/adminDataService'
import { adminUserCommand } from '../server/services/adminService'
import { recentMiniGameThrottle } from '../server/services/miniGameEconomyService'

assert.match(process.env.DATABASE_URL || '', /127\.0\.0\.1:55439\/poker_review_.*test/)
const realFetch = globalThis.fetch
const messages: any[] = []
process.env.TELEGRAM_BOT_TOKEN = 'isolated-test-token'
process.env.TELEGRAM_CHANNEL_CHAT_ID = '-1000000000000'
delete process.env.TELEGRAM_PROXY_URL
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/api.telegram.org\/botisolated-test-token\/sendMessage$/)
  messages.push(JSON.parse(String(options?.body)))
  return new Response(JSON.stringify({ ok: true, result: { message_id: messages.length } }))
}
after(async () => { globalThis.fetch = realFetch; await prisma.$disconnect() })
async function user(role = 'USER') {
  return prisma.user.create({ data: { username: 'review_' + randomUUID().slice(0, 12), passwordHash: hashPassword('Review-password-123'), role, phoneVerifiedAt: new Date(), balance: 5000, wallet: { create: { balance: 5000n } } } })
}
const command = () => ({ reason: 'Изолированная проверка', requestId: randomUUID() })

test('committed achievement only, rollback, concurrency, admin regrant and durable deduplication', async () => {
  await ensureAchievementDefinitions()
  while (await prisma.achievementNotification.count({ where: { attemptedAt: null } })) {
    await deliverAchievementNotifications()
  }
  const actor = await user('SUPERADMIN'), target = await user()
  const targetMessages = () => messages.filter(message => String(message.text).includes(target.username)).length
  const baseline = targetMessages()
  await assert.rejects(prisma.$transaction(async tx => {
    await unlockAchievement(tx, target.id, 'first_hand')
    await deliverAchievementNotifications()
    assert.equal(targetMessages(), baseline, 'uncommitted grant must not send')
    throw new Error('rollback')
  }), /rollback/)
  assert.equal(await prisma.achievementNotification.count({ where: { userId: target.id } }), 0)
  await Promise.all([1, 2, 3].map(() => prisma.$transaction(tx => unlockAchievement(tx, target.id, 'first_hand'))))
  await Promise.all([deliverAchievementNotifications(), deliverAchievementNotifications()])
  assert.equal(targetMessages() - baseline, 1)
  assert.match(messages.at(-1).text, new RegExp(target.username))
  assert.match(messages.at(-1).text, /Ачивка: За столом\nЗа что: Участие в первой раздаче/)
  const definition = await prisma.achievement.findUniqueOrThrow({ where: { code: 'first_hand' } })
  await adminAchievementCommand(actor.id, target.id, { ...command(), achievementId: definition.id, mode: 'revoke' })
  await adminAchievementCommand(actor.id, target.id, { ...command(), achievementId: definition.id, mode: 'grant' })
  await deliverAchievementNotifications()
  assert.equal(targetMessages() - baseline, 1)
})

test('Telegram link replay, unlink race, relink and award never rewarded twice', async () => {
  const target = await user(), token = await issueUserAuthToken(target.id)
  const link = await createTelegramLink(token)
  const raw = new URL(link.url).searchParams.get('start')!
  const chatId = Math.floor(Math.random() * 1e12)
  const update = { message: { chat: { id: chatId, type: 'private' }, from: { id: chatId, username: 'review' }, text: '/start ' + raw } }
  await handleTelegramUpdate({ message: { ...update.message, chat: { id: -123, type: 'supergroup' } } })
  assert.equal(await telegramStatus(token), null)
  await Promise.all([handleTelegramUpdate(update), handleTelegramUpdate(update)])
  assert.equal((await telegramStatus(token))?.isActive, true)
  assert.equal((await adminUserDetail(target.id)).balance, 20000n)
  await unlinkTelegram(token)
  assert.equal((await telegramStatus(token))?.isActive, false)
  const stale = await createTelegramLink(token)
  await unlinkTelegram(token)
  await handleTelegramUpdate({ message: { ...update.message, text: '/start ' + new URL(stale.url).searchParams.get('start') } })
  assert.equal((await telegramStatus(token))?.isActive, false)
  // Season/admin removal of the visible badge must not remove its first-grant record.
  await prisma.userAchievement.deleteMany({ where: { userId: target.id } })
  const next = await createTelegramLink(token)
  const reply = await handleTelegramUpdate({ message: { ...update.message, text: '/start ' + new URL(next.url).searchParams.get('start') } })
  assert.match((reply as any).text, /повторная награда не начисляется/)
  assert.equal((await adminUserDetail(target.id)).balance, 20000n)
  assert.equal(await prisma.userAchievement.count({ where: { userId: target.id, achievement: { code: 'telegram_subscriber' } } }), 0)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: target.id }, entryType: 'ACHIEVEMENT_REWARD' } }), 1)
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => { await unlinkTelegram(token); return previous(url, init) }
  await notifyTelegram(target.id, 'test')
  globalThis.fetch = previous
  assert.equal((await telegramStatus(token))?.isActive, false, 'in-flight notification must not relink')
})

test('balance persistence, idempotent retry, stale balance and no-op set', async () => {
  const actor = await user('SUPERADMIN'), target = await user()
  const input = { ...command(), action: 'credit' as const, amount: 100, expectedBalance: 5000 }
  await Promise.all([adminUserCommand(actor.id, target.id, input), adminUserCommand(actor.id, target.id, input)])
  assert.equal((await adminUserDetail(target.id)).balance, 5100n)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: target.id }, entryType: 'ADMIN_ADJUSTMENT' } }), 1)
  await assert.rejects(adminUserCommand(actor.id, target.id, { ...input, requestId: randomUUID() }), /Баланс изменился/)
  await adminUserCommand(actor.id, target.id, { ...command(), action: 'set-balance', amount: 5100, expectedBalance: 5100 })
  await adminUserCommand(actor.id, target.id, { ...command(), action: 'debit', amount: 100, expectedBalance: 5100 })
  assert.equal((await adminUserDetail(target.id)).balance, 5000n)
})

test('reset is user-scoped, preserves wallet, ledger, profile, Telegram, poker and awards; rejects active rocket/reused key/unauthorized actor', async () => {
  const actor = await user('SUPERADMIN'), target = await user(), other = await user()
  await prisma.$transaction(tx => unlockAchievement(tx, target.id, 'first_hand'))
  const chatId = String(Math.floor(Math.random() * 1e12))
  await prisma.telegramSubscription.create({ data: { userId: target.id, chatId, telegramUserId: chatId } })
  const round = await prisma.crashRound.create({ data: { phase: 'betting', crashAt: 200, seedHash: 'a'.repeat(64), seed: 'b'.repeat(64) } })
  await prisma.crashBet.createMany({ data: [target, other].map(u => ({ userId: u.id, roundId: round.id, stake: 100 })) })
  for (const u of [target, other]) {
    await prisma.miniGameSession.create({ data: { userId: u.id, bankUserId: actor.id, game: 'mines', status: 'ACTIVE', stake: 100n, bankReserve: 0n, maxPayout: 1000n, idempotencyKey: randomUUID() } })
    await prisma.minesCommitment.create({ data: { userId: u.id, serverSeed: 'c'.repeat(64), seedHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 60000) } })
  }
  const snapshot = async (id: string) => JSON.stringify(await prisma.user.findUnique({ where: { id }, include: { wallet: { include: { entries: true } }, achievements: true, telegramSubscription: true } }), (k, v) => ['updatedAt', 'miniGameResetAt'].includes(k) ? undefined : typeof v === 'bigint' ? v.toString() : v)
  const before = await snapshot(target.id), otherBefore = await snapshot(other.id)
  await assert.rejects(adminMiniGameResetCommand(actor.id, target.id, command()), /Дождитесь/)
  await prisma.crashRound.update({ where: { id: round.id }, data: { phase: 'crashed' } })
  await assert.rejects(adminMiniGameResetCommand(other.id, target.id, command()), /Права отозваны/)
  const input = command()
  await Promise.all([adminMiniGameResetCommand(actor.id, target.id, input), adminMiniGameResetCommand(actor.id, target.id, input)])
  assert.equal(await snapshot(target.id), before)
  assert.equal(await snapshot(other.id), otherBefore)
  for (const model of [prisma.miniGameSession, prisma.crashBet, prisma.minesCommitment] as any[]) {
    assert.equal(await model.count({ where: { userId: target.id } }), 0)
    assert.equal(await model.count({ where: { userId: other.id } }), 1)
  }
  await assert.rejects(adminMiniGameResetCommand(actor.id, other.id, input), /Ключ запроса/)
  const throttled = await prisma.$transaction(tx => recentMiniGameThrottle(tx, { game: 'mines', userId: target.id, payout: 100n }))
  assert.equal(throttled.factorBps, 10000)
})
