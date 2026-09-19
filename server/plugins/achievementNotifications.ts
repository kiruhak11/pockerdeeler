import { deliverAchievementNotifications } from '../services/achievementNotificationService'

export default defineNitroPlugin(app => {
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try { await deliverAchievementNotifications() }
    catch { console.error('[achievement notifications] Delivery worker failed') }
    if (!stopped) timer = setTimeout(poll, 2000)
  }
  app.hooks.hook('close', () => { stopped = true; if (timer) clearTimeout(timer) })
  void poll()
})
