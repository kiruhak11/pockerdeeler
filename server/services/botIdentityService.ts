import { randomUUID } from 'node:crypto'
import type { Prisma, User } from '@prisma/client'
import { prisma } from '../db/client'
import { DEFAULT_BALANCE } from './userAccountService'

export const BOT_INITIAL_BALANCE = DEFAULT_BALANCE

export const BOT_SKILL_TIERS = Object.freeze(['WEAK', 'CASUAL', 'REGULAR', 'STRONG'] as const)
export type BotSkillTier = typeof BOT_SKILL_TIERS[number]

export const BOT_PLAY_STYLES = Object.freeze([
  'TIGHT_AGGRESSIVE',
  'LOOSE_AGGRESSIVE',
  'TIGHT_PASSIVE',
  'LOOSE_PASSIVE',
  'BALANCED'
] as const)
export type BotPlayStyle = typeof BOT_PLAY_STYLES[number]

export type BotProfile = Readonly<{
  botKey: string
  nickname: string
  skillTier: BotSkillTier
  playStyle: BotPlayStyle
}>

/** Stable, server-owned identities. Do not reorder or rename these profiles. */
export const ONLINE_POKER_BOT_PROFILES: readonly BotProfile[] = Object.freeze([
  { botKey: 'online-bot-01', nickname: 'Mira Vale', skillTier: 'WEAK', playStyle: 'LOOSE_PASSIVE' },
  { botKey: 'online-bot-02', nickname: 'Anton Reed', skillTier: 'WEAK', playStyle: 'TIGHT_PASSIVE' },
  { botKey: 'online-bot-03', nickname: 'Nika Storm', skillTier: 'WEAK', playStyle: 'LOOSE_AGGRESSIVE' },
  { botKey: 'online-bot-04', nickname: 'Dani Kross', skillTier: 'CASUAL', playStyle: 'BALANCED' },
  { botKey: 'online-bot-05', nickname: 'Ilya North', skillTier: 'CASUAL', playStyle: 'TIGHT_AGGRESSIVE' },
  { botKey: 'online-bot-06', nickname: 'Sonia Hart', skillTier: 'CASUAL', playStyle: 'LOOSE_PASSIVE' },
  { botKey: 'online-bot-07', nickname: 'Max Volkov', skillTier: 'REGULAR', playStyle: 'LOOSE_AGGRESSIVE' },
  { botKey: 'online-bot-08', nickname: 'Lena Fox', skillTier: 'REGULAR', playStyle: 'TIGHT_AGGRESSIVE' },
  { botKey: 'online-bot-09', nickname: 'Rin Arden', skillTier: 'REGULAR', playStyle: 'BALANCED' },
  { botKey: 'online-bot-10', nickname: 'Oleg Stone', skillTier: 'STRONG', playStyle: 'TIGHT_PASSIVE' },
  { botKey: 'online-bot-11', nickname: 'Vera Moss', skillTier: 'STRONG', playStyle: 'TIGHT_AGGRESSIVE' },
  { botKey: 'online-bot-12', nickname: 'Kai River', skillTier: 'STRONG', playStyle: 'BALANCED' }
])

const BOT_PASSWORD_SENTINEL = 'bot-account-disabled'
const BOT_BOOTSTRAP_LOCK = 'online-poker-bot-bootstrap'
const ACCOUNT_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class OnlinePokerBotJoinError extends Error {
  readonly code: 'BOT_DISABLED' | 'PRIVATE_ROOM_BOT_FORBIDDEN'

  constructor(code: 'BOT_DISABLED' | 'PRIVATE_ROOM_BOT_FORBIDDEN', message: string) {
    super(message)
    this.name = 'OnlinePokerBotJoinError'
    this.code = code
  }
}

export type PersistentBotIdentity = Readonly<{
  id: string
  botKey: string
  nickname: string
  isBot: true
  botEnabled: boolean
  skillTier: BotSkillTier
  playStyle: BotPlayStyle
  balance: number
  tableRating: number
  tableHandsPlayed: number
  tableHandsWon: number
  predictionRating: number
  leaderboardVisible: boolean
}>

function toBotIdentity(user: Pick<User, 'id' | 'username' | 'isBot' | 'botKey' | 'botEnabled' | 'botSkillTier' | 'botPlayStyle' | 'balance' | 'tableRating' | 'tableHandsPlayed' | 'tableHandsWon' | 'predictionRating' | 'leaderboardVisible'>, walletBalance?: bigint | null): PersistentBotIdentity {
  if (!user.isBot || !user.botKey || !user.botSkillTier || !user.botPlayStyle) throw new Error('Stored bot identity metadata is invalid.')
  if (!(BOT_SKILL_TIERS as readonly string[]).includes(user.botSkillTier) || !(BOT_PLAY_STYLES as readonly string[]).includes(user.botPlayStyle)) throw new Error('Stored bot strategy metadata is invalid.')
  return Object.freeze({
    id: user.id,
    botKey: user.botKey,
    nickname: user.username,
    isBot: true,
    botEnabled: user.botEnabled,
    skillTier: user.botSkillTier as BotSkillTier,
    playStyle: user.botPlayStyle as BotPlayStyle,
    balance: Number(walletBalance ?? BigInt(user.balance)),
    tableRating: user.tableRating,
    tableHandsPlayed: user.tableHandsPlayed,
    tableHandsWon: user.tableHandsWon,
    predictionRating: user.predictionRating,
    leaderboardVisible: user.leaderboardVisible
  })
}

type BotUserRow = Pick<User, 'id' | 'username' | 'isBot' | 'botKey' | 'botEnabled' | 'botSkillTier' | 'botPlayStyle' | 'balance' | 'tableRating' | 'tableHandsPlayed' | 'tableHandsWon' | 'predictionRating' | 'leaderboardVisible'>

function assertProfileMatches(user: BotUserRow, profile: BotProfile): void {
  if (!user.isBot || user.botKey !== profile.botKey || user.username !== profile.nickname || user.botSkillTier !== profile.skillTier || user.botPlayStyle !== profile.playStyle) {
    throw new Error(`Stored bot identity for ${profile.botKey} does not match the bootstrap profile.`)
  }
}

async function ensureBotUser(tx: Prisma.TransactionClient, profile: BotProfile): Promise<BotUserRow> {
  const existing = await tx.user.findUnique({
    where: { botKey: profile.botKey },
    select: { id: true, username: true, isBot: true, botKey: true, botEnabled: true, botSkillTier: true, botPlayStyle: true, balance: true, tableRating: true, tableHandsPlayed: true, tableHandsWon: true, predictionRating: true, leaderboardVisible: true }
  })
  if (existing) {
    assertProfileMatches(existing, profile)
    if (!await tx.userWallet.findUnique({ where: { userId: existing.id }, select: { id: true } })) {
      const wallet = await tx.userWallet.create({ data: { userId: existing.id, balance: BigInt(Math.max(0, existing.balance)) } })
      if (wallet.balance > 0n) await tx.walletLedgerEntry.create({ data: {
        walletId: wallet.id,
        transferId: randomUUID(),
        entryType: 'BOT_ACCOUNT_OPENING_GRANT',
        amount: wallet.balance,
        balanceAfter: wallet.balance,
        idempotencyKey: `bot-wallet-opening:${profile.botKey}`,
        metadata: { reason: 'persistent_bot_bootstrap', botKey: profile.botKey }
      } })
    }
    return existing
  }

  const created = await tx.user.create({
    data: {
      username: profile.nickname,
      passwordHash: BOT_PASSWORD_SENTINEL,
      mustChangePassword: true,
      balance: BOT_INITIAL_BALANCE,
      isBot: true,
      botKey: profile.botKey,
      botSkillTier: profile.skillTier,
      botPlayStyle: profile.playStyle,
      botEnabled: true,
      leaderboardVisible: true
    },
    select: { id: true, username: true, isBot: true, botKey: true, botEnabled: true, botSkillTier: true, botPlayStyle: true, balance: true, tableRating: true, tableHandsPlayed: true, tableHandsWon: true, predictionRating: true, leaderboardVisible: true }
  })
  const wallet = await tx.userWallet.create({ data: { userId: created.id, balance: BigInt(BOT_INITIAL_BALANCE) } })
  await tx.walletLedgerEntry.create({ data: {
    walletId: wallet.id,
    transferId: randomUUID(),
    entryType: 'BOT_ACCOUNT_OPENING_GRANT',
    amount: BigInt(BOT_INITIAL_BALANCE),
    balanceAfter: BigInt(BOT_INITIAL_BALANCE),
    idempotencyKey: `bot-wallet-opening:${profile.botKey}`,
    metadata: { reason: 'persistent_bot_bootstrap', botKey: profile.botKey }
  } })
  return created
}

/** Idempotently creates the fixed server-side bot identities under one DB lock. */
export async function ensureOnlinePokerBots(): Promise<readonly PersistentBotIdentity[]> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BOT_BOOTSTRAP_LOCK}, 0))::text`
    const identities: PersistentBotIdentity[] = []
    for (const profile of ONLINE_POKER_BOT_PROFILES) {
      const user = await ensureBotUser(tx, profile)
      const wallet = await tx.userWallet.findUnique({ where: { userId: user.id }, select: { balance: true } })
      identities.push(toBotIdentity(user, wallet?.balance))
    }
    return Object.freeze(identities)
  })
}

export async function listOnlinePokerBots(): Promise<readonly PersistentBotIdentity[]> {
  const users = await prisma.user.findMany({
    where: { isBot: true, botKey: { not: null } },
    orderBy: { botKey: 'asc' },
    include: { wallet: { select: { balance: true } } }
  })
  return Object.freeze(users.map(user => toBotIdentity(user, user.wallet?.balance)))
}

export async function getOnlinePokerBotByKey(botKey: string): Promise<PersistentBotIdentity | null> {
  const user = await prisma.user.findUnique({ where: { botKey }, include: { wallet: { select: { balance: true } } } })
  return user ? toBotIdentity(user, user.wallet?.balance) : null
}

export async function setOnlinePokerBotEnabled(botKey: string, enabled: boolean): Promise<PersistentBotIdentity> {
  const updated = await prisma.user.updateMany({ where: { botKey, isBot: true }, data: { botEnabled: enabled } })
  if (updated.count !== 1) throw new Error('Online poker bot was not found.')
  const user = await prisma.user.findUniqueOrThrow({ where: { botKey }, include: { wallet: { select: { balance: true } } } })
  return toBotIdentity(user, user.wallet?.balance)
}

/** Reusable server-side guard for future bot seating paths. */
export async function assertOnlinePokerBotMayJoin(userId: string, visibility: 'PUBLIC' | 'PRIVATE'): Promise<void> {
  // Pure runtime tests and internal table identities may use opaque ids. Only
  // authenticated database accounts can be persistent bot identities.
  if (!process.env.DATABASE_URL || !ACCOUNT_USER_ID.test(userId)) return
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isBot: true, botEnabled: true } })
  if (!user?.isBot) return
  if (!user.botEnabled) throw new OnlinePokerBotJoinError('BOT_DISABLED', 'This poker bot is disabled.')
  if (visibility === 'PRIVATE') throw new OnlinePokerBotJoinError('PRIVATE_ROOM_BOT_FORBIDDEN', 'Bots cannot join private online rooms.')
}
