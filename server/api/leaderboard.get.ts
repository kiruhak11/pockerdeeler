import { createError, getQuery } from 'h3'
import { prisma } from '../db/client'
import { ACHIEVEMENTS } from '../services/achievementService'
import { accountCookie } from '../utils/accountCookie'
import { verifyUserAuthToken } from '../services/userAccountService'
import { assertPremiumFeature } from '../services/premiumService'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const sort = ['balance', 'rating', 'wins', 'achievements', 'streak'].includes(String(query.sort)) ? String(query.sort) : 'rating'
  const premiumOnly = String(query.premiumOnly || '') === 'true'
  if (premiumOnly) {
    const auth = await verifyUserAuthToken(accountCookie(event))
    if (!auth) throw createError({ statusCode: 401, message: 'Войдите в аккаунт' })
    await assertPremiumFeature(auth.userId, 'LEADERBOARD_PREMIUM_FILTER')
  }
  const now = new Date()
  const users = await prisma.user.findMany({
    where: { deletedAt: null, ...(premiumOnly ? { premiumSubscriptions: { some: { status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } } } } : {}) },
    orderBy: { username: 'asc' }, take: 500,
    include: {
      premiumSubscriptions: { where: { status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' }, take: 1 },
      achievements: { include: { achievement: true }, orderBy: { unlockedAt: 'asc' } },
      seasonalRewards: { include: { season: { select: { number: true } } }, orderBy: { createdAt: 'asc' } }
    }
  })
  const rows = users.map(user => {
    const ordinaryAchievements = ACHIEVEMENTS.map(definition => { const found = user.achievements.find(item => item.achievement.code === definition.code); return { id: definition.code, title: definition.title, description: definition.description, icon: definition.icon, rarity: definition.rarity, unlockedAt: found?.unlockedAt.toISOString() ?? null } })
    const seasonalAchievements = user.seasonalRewards.map(reward => ({ id: `season:${reward.id}`, title: reward.title, description: reward.description, icon: reward.icon, rarity: reward.rarity, unlockedAt: reward.createdAt.toISOString(), seasonal: true, seasonNumber: reward.season.number }))
    const achievementsList = [...seasonalAchievements, ...ordinaryAchievements]
    const selectedAchievementIcon = user.selectedAchievementCode || null
    return {
      userId: user.id,
      username: user.username,
      balance: user.balance,
      predictionRating: user.predictionRating,
      tableRating: user.tableRating,
      premiumType: user.premiumSubscriptions.length ? 'PREMIUM' as const : 'FREE' as const,
      premiumPlan: (user.premiumSubscriptions[0]?.plan || null) as 'LITE' | 'PRO' | 'ELITE' | null,
      selectedAchievementIcon,
      handsPlayed: user.tableHandsPlayed,
      predictions: user.predictionCount,
      predictionWins: user.predictionWins,
      wins: user.tableHandsWon,
      splitWins: user.predictionSplitWins,
      successPercent: user.predictionCount ? Math.round(user.predictionWins * 100 / user.predictionCount) : 0,
      streak: user.tableCurrentStreak,
      bestStreak: user.tableBestStreak,
      achievements: user.achievements.length + user.seasonalRewards.length,
      achievementsList
    }
  })
  const key = sort === 'rating' ? 'tableRating' : sort === 'wins' ? 'predictionWins' : sort
  rows.sort((a, b) => (b[key as keyof typeof b] as number) - (a[key as keyof typeof a] as number) || a.username.localeCompare(b.username))
  return { sort, premiumOnly, entries: rows.slice(0, 100).map((row, index) => ({ ...row, rank: index + 1 })) }
})
