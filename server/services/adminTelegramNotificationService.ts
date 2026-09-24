import { prisma } from '../db/client'
import { notifyTelegram } from './telegramService'

export const ADMIN_TELEGRAM_CATEGORIES = ['payments', 'users', 'games', 'premium', 'achievements'] as const
export type AdminTelegramCategory = typeof ADMIN_TELEGRAM_CATEGORIES[number]

export type AdminTelegramSettings = {
  enabled: boolean
  categories: Record<AdminTelegramCategory, boolean>
}

const SETTING_KEY = 'telegram_admin_notifications'
const defaults: AdminTelegramSettings = {
  enabled: true,
  categories: { payments: true, users: true, games: true, premium: true, achievements: true }
}
const pendingAdminTelegramNotifications = new Set<Promise<boolean>>()

export function normalizeAdminTelegramSettings(value: unknown): AdminTelegramSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawCategories = input.categories && typeof input.categories === 'object' ? input.categories as Record<string, unknown> : {}
  return {
    enabled: input.enabled !== false,
    categories: Object.fromEntries(ADMIN_TELEGRAM_CATEGORIES.map(category => [category, rawCategories[category] !== false])) as Record<AdminTelegramCategory, boolean>
  }
}

export async function getAdminTelegramSettings() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY }, select: { value: true } })
  return normalizeAdminTelegramSettings(row?.value ?? defaults)
}

async function sendAdminTelegramNotification(category: AdminTelegramCategory, text: string) {
  try {
    const settings = await getAdminTelegramSettings()
    if (!settings.enabled || !settings.categories[category]) return false
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, deletedAt: null, blockedAt: null, telegramSubscription: { is: { isActive: true } } },
      select: { id: true }
    })
    const results = await Promise.allSettled(admins.map(admin => notifyTelegram(admin.id, text)))
    return results.some(result => result.status === 'fulfilled' && result.value)
  } catch (error) {
    console.error('[telegram admin notification]', error instanceof Error ? error.message : String(error))
    return false
  }
}

export function notifyAdminTelegram(category: AdminTelegramCategory, text: string) {
  const task = sendAdminTelegramNotification(category, text)
  pendingAdminTelegramNotifications.add(task)
  void task.then(
    () => pendingAdminTelegramNotifications.delete(task),
    () => pendingAdminTelegramNotifications.delete(task)
  )
  return task
}

// Lets integration tests wait for detached admin sends before removing fixtures.
export async function awaitPendingAdminTelegramNotifications() {
  while (pendingAdminTelegramNotifications.size > 0) {
    await Promise.allSettled([...pendingAdminTelegramNotifications])
  }
}

export const adminTelegramSettingKey = SETTING_KEY
