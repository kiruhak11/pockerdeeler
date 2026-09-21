import { createError, getQuery, setHeader } from 'h3'
import { prisma } from '../db/client'
import { ACHIEVEMENTS } from '../services/achievementService'
import { accountCookie } from '../utils/accountCookie'
import { verifyUserAuthToken } from '../services/userAccountService'
import { assertPremiumFeature } from '../services/premiumService'
import { toPublicLeaderboardRow } from '../services/publicLeaderboardService'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
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
    where: { deletedAt: null, leaderboardVisible: true, ...(premiumOnly ? { premiumSubscriptions: { some: { status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } } } } : {}) },
    orderBy: { username: 'asc' }, take: 500,
    include: {
      premiumSubscriptions: { where: { status: 'ACTIVE', startedAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' }, take: 1 },
      wallet: { select: { balance: true } },
      achievements: { include: { achievement: true }, orderBy: { unlockedAt: 'asc' } },
      seasonalRewards: { include: { season: { select: { number: true } } }, orderBy: { createdAt: 'asc' } }
    }
  })
  const rows: Array<Record<string, unknown>> = users.flatMap(user => {
    const ordinaryAchievements = ACHIEVEMENTS.map(definition => { const found = user.achievements.find(item => item.achievement.code === definition.code); return { id: definition.code, title: definition.title, description: definition.description, icon: definition.icon, rarity: definition.rarity, unlockedAt: found?.unlockedAt.toISOString() ?? null } })
    const seasonalAchievements = user.seasonalRewards.map(reward => ({ id: `season:${reward.id}`, title: reward.title, description: reward.description, icon: reward.icon, rarity: reward.rarity, unlockedAt: reward.createdAt.toISOString(), seasonal: true, seasonNumber: reward.season.number }))
    const achievementsList = [...seasonalAchievements, ...ordinaryAchievements]
    return [toPublicLeaderboardRow({
      userId: user.id,
      username: user.username,
      balance: Number(user.wallet?.balance ?? BigInt(user.balance)),
      predictionRating: user.predictionRating,
      tableRating: user.tableRating,
      tableHandsPlayed: user.tableHandsPlayed,
      tableHandsWon: user.tableHandsWon,
      tableCurrentStreak: user.tableCurrentStreak,
      tableBestStreak: user.tableBestStreak,
      predictionCount: user.predictionCount,
      predictionWins: user.predictionWins,
      predictionSplitWins: user.predictionSplitWins,
      selectedAchievementIcon: user.selectedAchievementCode || null,
      achievements: user.achievements.length + user.seasonalRewards.length,
      achievementsList
    })]
  })
  const key = sort === 'rating' ? 'tableRating' : sort === 'wins' ? 'predictionWins' : sort
  rows.sort((a, b) => (typeof b[key] === 'number' ? b[key] as number : 0) - (typeof a[key] === 'number' ? a[key] as number : 0) || String(a.username).localeCompare(String(b.username)))
  return { sort, premiumOnly, entries: rows.slice(0, 100).map((row, index) => ({ ...row, rank: index + 1 })) }
})
