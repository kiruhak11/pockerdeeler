import { createError, getQuery, setHeader } from 'h3'
import { prisma } from '../db/client'
import { ACHIEVEMENTS } from '../services/achievementService'
import { accountCookie } from '../utils/accountCookie'
import { verifyUserAuthToken } from '../services/userAccountService'
import { assertPremiumFeature } from '../services/premiumService'
import { getDistributionPermissionsForUsers, filterPublicUserData } from '../services/distributionConsentService'

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
      achievements: { include: { achievement: true }, orderBy: { unlockedAt: 'asc' } },
      seasonalRewards: { include: { season: { select: { number: true } } }, orderBy: { createdAt: 'asc' } }
    }
  })
  const permissionsByUser = await getDistributionPermissionsForUsers(users.map(user => user.id))
  const rows = users.flatMap(user => {
    const permissions = permissionsByUser.get(user.id) || new Set()
    const ordinaryAchievements = ACHIEVEMENTS.map(definition => { const found = user.achievements.find(item => item.achievement.code === definition.code); return { id: definition.code, title: definition.title, description: definition.description, icon: definition.icon, rarity: definition.rarity, unlockedAt: found?.unlockedAt.toISOString() ?? null } })
    const seasonalAchievements = user.seasonalRewards.map(reward => ({ id: `season:${reward.id}`, title: reward.title, description: reward.description, icon: reward.icon, rarity: reward.rarity, unlockedAt: reward.createdAt.toISOString(), seasonal: true, seasonNumber: reward.season.number }))
    const achievementsList = [...seasonalAchievements, ...ordinaryAchievements]
    const selectedAchievementIcon = user.selectedAchievementCode || null
    const row: Record<string, unknown> = {
      username: user.username,
      predictionRating: user.predictionRating,
      tableRating: user.tableRating,
      ...permissions.has('VIRTUAL_BALANCE') ? { balance: user.balance } : {},
      ...permissions.has('GAME_STATISTICS') ? {
        handsPlayed: user.tableHandsPlayed,
        predictions: user.predictionCount,
        predictionWins: user.predictionWins,
        wins: user.tableHandsWon,
        splitWins: user.predictionSplitWins,
        successPercent: user.predictionCount ? Math.round(user.predictionWins * 100 / user.predictionCount) : 0,
        streak: user.tableCurrentStreak,
        bestStreak: user.tableBestStreak
      } : {},
      ...permissions.has('ACHIEVEMENTS') ? { selectedAchievementIcon, achievements: user.achievements.length + user.seasonalRewards.length, achievementsList } : {}
    }
    // Username and rating are the minimum game leaderboard DTO. Their
    // publication is controlled by leaderboardVisible, not legal consent.
    return [filterPublicUserData(row, permissions, { balance: 'VIRTUAL_BALANCE', handsPlayed: 'GAME_STATISTICS', predictions: 'GAME_STATISTICS', predictionWins: 'GAME_STATISTICS', wins: 'GAME_STATISTICS', splitWins: 'GAME_STATISTICS', successPercent: 'GAME_STATISTICS', streak: 'GAME_STATISTICS', bestStreak: 'GAME_STATISTICS', selectedAchievementIcon: 'ACHIEVEMENTS', achievements: 'ACHIEVEMENTS', achievementsList: 'ACHIEVEMENTS' })]
  })
  const key = sort === 'rating' ? 'tableRating' : sort === 'wins' ? 'predictionWins' : sort
  rows.sort((a, b) => (typeof b[key] === 'number' ? b[key] as number : 0) - (typeof a[key] === 'number' ? a[key] as number : 0) || String(a.username).localeCompare(String(b.username)))
  return { sort, premiumOnly, entries: rows.slice(0, 100).map((row, index) => ({ ...row, rank: index + 1 })) }
})
