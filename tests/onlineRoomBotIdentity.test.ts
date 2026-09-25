import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  BOT_INITIAL_BALANCE,
  ONLINE_POKER_BOT_PROFILES,
  assertOnlinePokerBotMayJoin,
  ensureOnlinePokerBots,
  getOnlinePokerBotByKey,
  listOnlinePokerBots,
  setOnlinePokerBotEnabled,
  OnlinePokerBotJoinError
} from '../server/services/botIdentityService'
import { issueUserAuthToken, loginUser } from '../server/services/userAccountService'
import { seasonLeaderboard } from '../server/services/seasonService'

const dbUrl = process.env.DATABASE_URL
const db = new PrismaClient()
let bots: Awaited<ReturnType<typeof ensureOnlinePokerBots>> = []

before(async () => {
  if (dbUrl) bots = await ensureOnlinePokerBots()
})

after(async () => {
  await db.$disconnect()
})

test('bootstrap creates twenty-four persistent bot identities', { skip: !dbUrl }, async () => {
  assert.equal(bots.length, 24)
  assert.equal(new Set(bots.map(bot => bot.id)).size, 24)
  assert.equal(new Set(bots.map(bot => bot.botKey)).size, 24)
  assert.equal(new Set(bots.map(bot => bot.nickname)).size, 24)
  assert.ok(bots.every(bot => bot.isBot && typeof bot.botEnabled === 'boolean' && bot.leaderboardVisible))
})

test('bot profiles have varied, validated strategy metadata', { skip: !dbUrl }, async () => {
  assert.deepEqual(bots.map(bot => bot.botKey), ONLINE_POKER_BOT_PROFILES.map(profile => profile.botKey))
  assert.ok(new Set(bots.map(bot => bot.skillTier)).size >= 4)
  assert.ok(new Set(bots.map(bot => bot.playStyle)).size >= 4)
})

test('repeated bootstrap preserves identity, rating, stats and balance', { skip: !dbUrl }, async () => {
  const target = bots[0]!
  const original = await db.user.findUniqueOrThrow({ where: { id: target.id }, include: { wallet: true } })
  await db.$transaction(async tx => {
    await tx.user.update({ where: { id: target.id }, data: { tableRating: 1234, tableHandsPlayed: 7, tableHandsWon: 3, balance: 4321 } })
    await tx.userWallet.update({ where: { userId: target.id }, data: { balance: 4321n } })
  })
  try {
    const repeated = await ensureOnlinePokerBots()
    const preserved = repeated.find(bot => bot.id === target.id)
    assert.ok(preserved)
    assert.equal(preserved.tableRating, 1234)
    assert.equal(preserved.tableHandsPlayed, 7)
    assert.equal(preserved.tableHandsWon, 3)
    assert.equal(preserved.balance, 4321)
    assert.equal(preserved.botKey, target.botKey)
  } finally {
    await db.$transaction(async tx => {
      await tx.user.update({ where: { id: target.id }, data: { tableRating: original.tableRating, tableHandsPlayed: original.tableHandsPlayed, tableHandsWon: original.tableHandsWon, balance: original.balance } })
      await tx.userWallet.update({ where: { userId: target.id }, data: { balance: original.wallet!.balance } })
    })
  }
})

test('each bot has one idempotent opening grant in the ordinary wallet ledger', { skip: !dbUrl }, async () => {
  const entries = await db.walletLedgerEntry.findMany({ where: { idempotencyKey: { in: bots.map(bot => `bot-wallet-opening:${bot.botKey}`) } }, select: { idempotencyKey: true, amount: true } })
  assert.equal(entries.length, bots.length)
  assert.ok(entries.every(entry => entry.amount === BigInt(BOT_INITIAL_BALANCE)))
  assert.equal(new Set(entries.map(entry => entry.idempotencyKey)).size, bots.length)
  assert.ok(bots.every(bot => Number.isSafeInteger(bot.balance) && bot.balance >= 0))
})

test('bots use normal wallets and ordinary leaderboard pipelines', { skip: !dbUrl }, async () => {
  const rows = await db.user.findMany({ where: { isBot: true, leaderboardVisible: true }, select: { id: true, username: true, wallet: { select: { id: true } } } })
  const botIds = new Set(bots.map(bot => bot.id))
  const provisionedRows = rows.filter(row => botIds.has(row.id))
  assert.equal(provisionedRows.length, bots.length)
  assert.ok(provisionedRows.every(row => row.wallet))
  const season = await seasonLeaderboard('balance')
  assert.ok(bots.every(bot => season.entries.some(entry => entry.userId === bot.id && entry.username === bot.nickname)))
})

test('bot identities cannot authenticate or create ordinary sessions', { skip: !dbUrl }, async () => {
  const bot = bots[0]!
  const before = await db.accountSession.count({ where: { userId: bot.id } })
  await assert.rejects(() => loginUser({ username: bot.nickname, password: 'bot-account-disabled' }), (error: any) => error?.statusCode === 401)
  await assert.rejects(() => issueUserAuthToken(bot.id), (error: any) => error?.statusCode === 401)
  assert.equal(await db.accountSession.count({ where: { userId: bot.id } }), before)
})

test('bots are rejected from private rooms but allowed for future public seating', { skip: !dbUrl }, async () => {
  const bot = bots[0]!
  await assert.rejects(() => assertOnlinePokerBotMayJoin(bot.id, 'PRIVATE'), (error: unknown) => error instanceof OnlinePokerBotJoinError && error.code === 'PRIVATE_ROOM_BOT_FORBIDDEN')
  await assert.doesNotReject(() => assertOnlinePokerBotMayJoin(bot.id, 'PUBLIC'))
})

test('disabled bots are rejected without deleting their identity', { skip: !dbUrl }, async () => {
  const bot = bots[1]!
  await setOnlinePokerBotEnabled(bot.botKey, false)
  try {
    await assert.rejects(() => assertOnlinePokerBotMayJoin(bot.id, 'PUBLIC'), (error: unknown) => error instanceof OnlinePokerBotJoinError && error.code === 'BOT_DISABLED')
    assert.equal((await getOnlinePokerBotByKey(bot.botKey))?.id, bot.id)
  } finally {
    await setOnlinePokerBotEnabled(bot.botKey, true)
  }
  const listedIds = new Set((await listOnlinePokerBots()).map(bot => bot.id))
  assert.ok(bots.every(bot => listedIds.has(bot.id)))
})

test('bootstrap does not grant achievements or notifications', { skip: !dbUrl }, async () => {
  const beforeAchievements = await db.userAchievement.count({ where: { userId: { in: bots.map(bot => bot.id) } } })
  const beforeEvents = await db.telegramUserEvent.count({ where: { userId: { in: bots.map(bot => bot.id) } } })
  await ensureOnlinePokerBots()
  const afterAchievements = await db.userAchievement.count({ where: { userId: { in: bots.map(bot => bot.id) } } })
  const afterEvents = await db.telegramUserEvent.count({ where: { userId: { in: bots.map(bot => bot.id) } } })
  assert.equal(afterAchievements, beforeAchievements)
  assert.equal(afterEvents, beforeEvents)
})
