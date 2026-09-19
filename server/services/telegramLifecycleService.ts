import { prisma } from '../db/client'
import { queueTelegramUserEvent } from './notificationService'
import { premiumExpirationEventKey } from './premiumService'

export { premiumExpirationEventKey }
export const seasonFinishedEventKey = (seasonId: string, userId: string) => `season-finished:${seasonId}:${userId}`
export const seasonStartedEventKey = (seasonId: string, userId: string) => `season-started:${seasonId}:${userId}`

export async function enqueueExpiredPremiumEvents() {
  const now = new Date()
  return prisma.$transaction(async tx => {
    const subscriptions = await tx.premiumSubscription.findMany({ where: { status: 'ACTIVE', expiresAt: { lte: now } }, select: { id: true, userId: true, plan: true, expiresAt: true }, take: 200 })
    let count = 0
    for (const subscription of subscriptions) {
      await tx.premiumSubscription.updateMany({ where: { id: subscription.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } })
      if (await queueTelegramUserEvent(tx, { userId: subscription.userId, category: 'premium', eventKey: premiumExpirationEventKey(subscription.id), text: `Ваш Premium ${subscription.plan} закончился ${subscription.expiresAt.toLocaleString('ru-RU')}.` })) count++
    }
    return count
  })
}
