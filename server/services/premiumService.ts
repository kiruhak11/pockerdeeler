import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { queueTelegramUserEvent } from './notificationService'
import type { PremiumAccess, PremiumFeature, PremiumPlan } from '../../app/types/premium'

export const premiumExpirationEventKey = (subscriptionId: string) => `premium-expired:${subscriptionId}`

export const PREMIUM_PLANS = [
  { plan: 'LITE' as const, name: 'Premium Lite', priceRub: 149, durationDays: 30 },
  { plan: 'PRO' as const, name: 'Premium Pro', priceRub: 299, durationDays: 30 },
  { plan: 'ELITE' as const, name: 'Premium Elite', priceRub: 499, durationDays: 30 }
]

const LITE: PremiumFeature[] = ['PREMIUM_BADGE','PREMIUM_FRAMES','ADDITIONAL_THEMES','EXTENDED_HISTORY','BASIC_STATS','POKER_HANDS_GUIDE','ROOM_CHAT']
const PRO: PremiumFeature[] = [...LITE,'ADVANCED_ANALYTICS','BALANCE_CHART','EXTENDED_POKER_STATS','EXTENDED_MINIGAME_STATS','PREMIUM_ACHIEVEMENTS','VISUAL_SETTINGS']
const ELITE: PremiumFeature[] = [...PRO,'ELITE_BADGE','PREMIUM_NAME_COLOR','ANIMATED_PROFILE_FRAME','PROFILE_PRESETS','EXTENDED_PROFILE_STYLE','LEADERBOARD_PREMIUM_FILTER']
export const PREMIUM_FEATURES: Record<PremiumPlan, PremiumFeature[]> = { LITE, PRO, ELITE }

export function premiumExpiresAt(startedAt: Date) {
  return new Date(startedAt.getTime() + 30 * 86_400_000)
}

/** Trusted server-side entry point for a future payment flow or an audited admin command. */
export async function activatePremiumSubscription(userId: string, plan: PremiumPlan, startedAt = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`
    await tx.premiumSubscription.updateMany({ where: { userId, status: 'ACTIVE' }, data: { status: 'CANCELLED' } })
    return tx.premiumSubscription.create({ data: { userId, plan, startedAt, expiresAt: premiumExpiresAt(startedAt), status: 'ACTIVE' } })
  })
}

const premiumAchievements = (plan: PremiumPlan) => plan === 'LITE' ? [] : [
  { code: 'premium-club', title: 'Участник Premium Club', description: 'Косметическое достижение активного Premium Pro.', icon: '◆' },
  ...(plan === 'ELITE' ? [{ code: 'premium-elite', title: 'Elite Club', description: 'Косметическое достижение активного Premium Elite.', icon: '✦' }] : [])
]

export async function getPremiumAccess(userId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<PremiumAccess> {
  const now = new Date()
  const expired = await client.premiumSubscription.findMany({ where: { userId, status: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true, plan: true, expiresAt: true } })
  if (expired.length) {
    await client.premiumSubscription.updateMany({ where: { userId, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } })
    for (const subscription of expired) {
      await queueTelegramUserEvent(client, { userId, category: 'premium', eventKey: premiumExpirationEventKey(subscription.id), text: `Ваш Premium ${subscription.plan} закончился ${subscription.expiresAt.toLocaleString('ru-RU')}.` })
    }
  }
  const subscription = await client.premiumSubscription.findFirst({ where: { userId, status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } }, orderBy: [{ expiresAt: 'desc' }, { createdAt: 'desc' }] })
  if (!subscription || !['LITE','PRO','ELITE'].includes(subscription.plan)) return { active:false,plan:null,status:'NONE',startedAt:null,expiresAt:null,features:[],achievements:[] }
  const plan = subscription.plan as PremiumPlan
  return { active:true,plan,status:'ACTIVE',startedAt:subscription.startedAt.toISOString(),expiresAt:subscription.expiresAt.toISOString(),features:[...PREMIUM_FEATURES[plan]],achievements:premiumAchievements(plan) }
}

export async function assertPremiumFeature(userId: string, feature: PremiumFeature) {
  const access = await getPremiumAccess(userId)
  if (!access.features.includes(feature)) throw createError({ statusCode: 403, message: 'Эта функция доступна в другом тарифе Premium' })
  return access
}

export async function getPremiumSettings(userId: string) {
  const access = await getPremiumAccess(userId)
  if (!access.active) return { access, locked: true, settings: null }
  const row = await prisma.premiumUserSettings.findUnique({ where: { userId } })
  return { access, locked: false, settings: row?.settings || {} }
}

export async function savePremiumSettings(userId: string, settings: Record<string, unknown>) {
  const access = await getPremiumAccess(userId)
  if (!access.active) throw createError({ statusCode: 403, message: 'Нужна активная подписка Premium' })
  if ((settings.nameColor || settings.profilePreset || settings.animatedFrame) && access.plan !== 'ELITE') throw createError({ statusCode: 403, message: 'Оформление доступно в Premium Elite' })
  if (settings.interfaceStyle && !access.features.includes('VISUAL_SETTINGS')) throw createError({ statusCode: 403, message: 'Настройка интерфейса доступна в Premium Pro и Elite' })
  const existing = await prisma.premiumUserSettings.findUnique({ where: { userId }, select: { settings: true } })
  const previous = existing?.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings) ? existing.settings as Prisma.JsonObject : {}
  const jsonSettings = { ...previous, ...settings } as Prisma.InputJsonObject
  const row = await prisma.premiumUserSettings.upsert({ where:{userId}, create:{userId,settings:jsonSettings}, update:{settings:jsonSettings} })
  return { access, settings: row.settings }
}

export async function premiumSummary(userId: string) {
  const access = await assertPremiumFeature(userId, 'BASIC_STATS')
  const [user, wallet, rocket, mines] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tableHandsPlayed: true, tableHandsWon: true, predictionCount: true, predictionWins: true } }),
    prisma.userWallet.findUnique({ where: { userId }, select: { balance: true } }),
    prisma.crashBet.aggregate({ where: { userId }, _count: { _all: true } }),
    prisma.miniGameSession.aggregate({ where: { userId }, _count: { _all: true } })
  ])
  return {
    access,
    balance: Number(wallet?.balance ?? 0),
    poker: { hands: user.tableHandsPlayed, wins: user.tableHandsWon },
    predictions: { total: user.predictionCount, wins: user.predictionWins },
    miniGames: { rocketGames: rocket._count._all, minesGames: mines._count._all }
  }
}

export async function premiumAnalytics(userId: string) {
  const access = await assertPremiumFeature(userId, 'ADVANCED_ANALYTICS')
  const [user, wallet, rocket, mines] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where:{id:userId}, select:{tableHandsPlayed:true,tableHandsWon:true,tableBestStreak:true,predictionCount:true,predictionWins:true,predictionSplitWins:true,tableRating:true,predictionRating:true} }),
    prisma.userWallet.findUnique({ where:{userId}, include:{entries:{orderBy:{createdAt:'desc'},take:180}} }),
    prisma.crashBet.aggregate({ where:{userId}, _count:{_all:true}, _sum:{stake:true,payout:true} }),
    prisma.miniGameSession.aggregate({ where:{userId}, _count:{_all:true}, _sum:{stake:true,payout:true} })
  ])
  const series = [...(wallet?.entries || [])].reverse().map(item => ({ at:item.createdAt.toISOString(), balance:Number(item.balanceAfter) }))
  return { access, balance: Number(wallet?.balance || 0), balanceSeries:series, poker:{hands:user.tableHandsPlayed,wins:user.tableHandsWon,winRate:user.tableHandsPlayed?Math.round(user.tableHandsWon*100/user.tableHandsPlayed):0,bestStreak:user.tableBestStreak,tableRating:user.tableRating,predictions:user.predictionCount,predictionWins:user.predictionWins,predictionSplitWins:user.predictionSplitWins,predictionRating:user.predictionRating}, miniGames:{rocket:{games:rocket._count._all,stake:rocket._sum.stake||0,payout:rocket._sum.payout||0},mines:{games:mines._count._all,stake:Number(mines._sum.stake||0),payout:Number(mines._sum.payout||0)}} }
}
