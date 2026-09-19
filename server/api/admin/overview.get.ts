import { requireAdmin, jsonSafe } from '../../utils/adminAuth'
import { prisma } from '../../db/client'
import { grantAllAchievementsToAdmin } from '../../services/achievementService'
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  await prisma.$transaction(tx => grantAllAchievementsToAdmin(tx, admin.id))
  const [users, rooms, liveHands, free, rewardsToday] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }), prisma.room.count(), prisma.hand.count({ where: { status: 'active' } }),
    prisma.userWallet.aggregate({ _sum: { balance: true }, where: { user: { deletedAt: null } } }),
    prisma.rewardSession.count({ where: { status: 'completed', completedAt: { gte: new Date(Date.now() - 86400000) } } })
  ])
  return jsonSafe({ users, rooms, liveHands, freePoints: free._sum.balance || 0n, rewardsToday })
})
