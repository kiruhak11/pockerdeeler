import { prisma } from '../db/client'
import { notifyTelegram } from './telegramService'

export const USER_TELEGRAM_CATEGORIES = ['purchases', 'premium', 'friends', 'games', 'achievements', 'seasons', 'adminChanges'] as const
export type UserTelegramCategory = typeof USER_TELEGRAM_CATEGORIES[number]
type Settings = Record<UserTelegramCategory, boolean>

const defaults: Settings = { purchases: true, premium: true, friends: true, games: true, achievements: true, seasons: true, adminChanges: true }

export function normalizeUserTelegramSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(USER_TELEGRAM_CATEGORIES.map(key => [key, raw[key] !== false])) as Settings
}

export async function getUserTelegramSettings(userId: string) {
  const row = await prisma.telegramNotificationSettings.findUnique({ where: { userId }, select: { settings: true } })
  return normalizeUserTelegramSettings(row?.settings ?? defaults)
}

export async function saveUserTelegramSettings(userId: string, settings: Partial<Settings>) {
  const next = normalizeUserTelegramSettings(settings)
  const row = await prisma.telegramNotificationSettings.upsert({ where: { userId }, create: { userId, settings: next }, update: { settings: next }, select: { settings: true } })
  return normalizeUserTelegramSettings(row.settings)
}

export async function notifyUserTelegram(userId: string, category: UserTelegramCategory, text: string) {
  try {
    const settings = await getUserTelegramSettings(userId)
    if (!settings[category]) return false
    return notifyTelegram(userId, text)
  } catch (error) {
    console.error('[telegram user notification]', error instanceof Error ? error.message : String(error))
    return false
  }
}

export function dispatchUserTelegram(userId: string, category: UserTelegramCategory, text: string) {
  void notifyUserTelegram(userId, category, text)
}

export async function queueTelegramUserEvent(tx: Pick<import('@prisma/client').Prisma.TransactionClient, 'telegramUserEvent'>, input: { userId: string; category: UserTelegramCategory; eventKey: string; text: string }) {
  const created = await tx.telegramUserEvent.createMany({ data: input, skipDuplicates: true })
  return created.count === 1
}

export async function deliverTelegramUserEvents() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 0
  let delivered = 0
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.$queryRaw<{ id: string; user_id: string; category: string; text: string }[]>`
      UPDATE telegram_user_events SET attempted_at = clock_timestamp()
      WHERE id = (SELECT id FROM telegram_user_events WHERE attempted_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, user_id, category, text`
    const row = rows[0]
    if (!row) break
    const sent = await notifyUserTelegram(row.user_id, row.category as UserTelegramCategory, row.text)
    if (sent) {
      await prisma.telegramUserEvent.update({ where: { id: row.id }, data: { sentAt: new Date() } })
      delivered++
    }
  }
  return delivered
}
