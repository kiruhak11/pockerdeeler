import { createError } from 'h3'
import { accountCookie } from '../../utils/accountCookie'
import { prisma } from '../../db/client'
import { verifyUserAuthToken } from '../../services/userAccountService'
import { ACHIEVEMENTS, ensureAchievementDefinitions, unlockBalanceAchievements } from '../../services/achievementService'

export default defineEventHandler(async event => {
  const auth = await verifyUserAuthToken(accountCookie(event))
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Требуется авторизация' })
  await prisma.$transaction(async tx => {
    await ensureAchievementDefinitions(tx)
    const wallet = await tx.userWallet.findUnique({ where: { userId: auth.userId }, select: { balance: true } })
    if (wallet) await unlockBalanceAchievements(tx, auth.userId, wallet.balance)
  })
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: {
    selectedAchievementCode: true,
    achievements: { include: { achievement: true }, orderBy: { unlockedAt: 'desc' } },
    seasonalRewards: { include: { season: { select: { number: true } } }, orderBy: { createdAt: 'desc' } }
  } })
  const owned = new Map(user.achievements.map(item => [item.achievement.code, item]))
  const ordinary = ACHIEVEMENTS.map(definition => { const item = owned.get(definition.code); return { ...definition, unlocked: Boolean(item), unlockedAt: item?.unlockedAt.toISOString() ?? null, seasonal: false } })
  const seasonal = user.seasonalRewards.map(reward => ({
    code: `season:${reward.id}`,
    rewardId: reward.id,
    title: reward.title,
    description: reward.description,
    icon: reward.icon,
    rarity: reward.rarity,
    ratingReward: 0,
    moneyReward: 0,
    unlocked: true,
    unlockedAt: reward.createdAt.toISOString(),
    seasonal: true,
    seasonNumber: reward.season.number,
    category: reward.category,
    place: reward.place
  }))
  return { selectedCode: user.selectedAchievementCode, achievements: [...seasonal, ...ordinary] }
})
