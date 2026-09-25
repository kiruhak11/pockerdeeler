import { reconcileStaleOnlineRoomParticipants, recoverIncompleteOnlineStackOperations } from '../services/onlineRoomApiService'

export default defineNitroPlugin(app => {
  if (import.meta.prerender || !process.env.DATABASE_URL || !process.env.REDIS_URL) return
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    const recovered = await recoverIncompleteOnlineStackOperations().catch(() => null)
    if (recovered === null) console.error('[online stack recovery] Reconciliation deferred.')
    else if (recovered > 0) console.info(`[online stack recovery] Completed ${recovered} pending operation(s).`)
    const cleaned = await reconcileStaleOnlineRoomParticipants().catch(() => null)
    if (cleaned === null) console.error('[online room cleanup] Reconciliation deferred.')
    else if (cleaned > 0) console.info(`[online room cleanup] Cashed out ${cleaned} stale participant(s).`)
    if (!stopped) timer = setTimeout(() => { void tick() }, 15_000)
  }
  app.hooks.hook('close', () => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
  void tick()
})
