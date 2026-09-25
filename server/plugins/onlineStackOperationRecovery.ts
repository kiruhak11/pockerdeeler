import { recoverIncompleteOnlineStackOperations } from '../services/onlineRoomApiService'

export default defineNitroPlugin(() => {
  if (import.meta.prerender || !process.env.DATABASE_URL || !process.env.REDIS_URL) return
  void recoverIncompleteOnlineStackOperations().then(recovered => {
    if (recovered > 0) console.info(`[online stack recovery] Completed ${recovered} pending operation(s).`)
  }).catch(() => {
    // Request-driven room reads retry recovery if startup dependencies are unavailable.
    console.error('[online stack recovery] Startup reconciliation deferred.')
  })
})
