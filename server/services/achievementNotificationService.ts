import { prisma } from '../db/client'
import { notifyTelegramChannel } from './telegramService'
import { notifyAdminTelegram } from './adminTelegramNotificationService'
import { notifyUserTelegram } from './notificationService'

export async function deliverAchievementNotifications() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  // Only committed grants are visible here. Claim before network I/O across all workers.
  // Telegram has no idempotency key: an ambiguous send must not be retried automatically.
  for (let i = 0; i < 20; i++) {
    const rows = await prisma.$queryRaw<{ id: string; user_id: string; text: string }[]>`
      UPDATE achievement_notifications SET attempted_at = clock_timestamp()
      WHERE id = (SELECT id FROM achievement_notifications WHERE attempted_at IS NULL
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, user_id, text`
    const row = rows[0]
    if (!row) return
    const channelSent = process.env.TELEGRAM_CHANNEL_CHAT_ID ? await notifyTelegramChannel(row.text) : false
    const userSent = await notifyUserTelegram(row.user_id, 'achievements', row.text)
    if (channelSent || userSent) {
      await prisma.achievementNotification.update({ where: { id: row.id }, data: { sentAt: new Date() } })
      if (channelSent) await notifyAdminTelegram('achievements', row.text)
    } else console.error('[achievement notification not confirmed]', { id: row.id })
  }
}
