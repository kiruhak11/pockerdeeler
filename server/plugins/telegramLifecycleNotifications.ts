import { deliverTelegramUserEvents } from '../services/notificationService'
import { enqueueExpiredPremiumEvents } from '../services/telegramLifecycleService'

export default defineNitroPlugin(app => {
  if (!process.env.DATABASE_URL) return
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try {
      await enqueueExpiredPremiumEvents()
      await deliverTelegramUserEvents()
    } catch (error) {
      console.error('[telegram lifecycle notifications]', error instanceof Error ? error.message : String(error))
    }
    if (!stopped) timer = setTimeout(poll, 30_000)
  }
  app.hooks.hook('close', () => { stopped = true; if (timer) clearTimeout(timer) })
  void poll()
})
