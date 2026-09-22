import { ensureOnlinePokerBots } from '../services/botIdentityService'
import { onlinePokerBotApiAdapter } from '../services/onlinePokerBotApiAdapter'
import { OnlinePokerBotOrchestrator, readOnlinePokerBotOrchestratorConfig } from '../services/onlinePokerBotOrchestrator'
import { OnlinePokerBotLeaseService } from '../services/onlinePokerBotLeaseService'

const config = readOnlinePokerBotOrchestratorConfig()

export default defineNitroPlugin(app => {
  // Off by default. With the flag disabled, no bot DB reads, room operations,
  // Redis lease, or autonomous action is performed.
  if (!config.enabled || !process.env.DATABASE_URL || !process.env.REDIS_URL) return
  const lease = new OnlinePokerBotLeaseService()
  const orchestrator = new OnlinePokerBotOrchestrator({
    config,
    lease,
    adapter: onlinePokerBotApiAdapter,
    log: (event, fields) => console.info(`[online poker bots] ${event}`, fields)
  })
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    try {
      await ensureOnlinePokerBots()
      await orchestrator.tick()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      console.error('[online poker bots] tick failed', typeof code === 'string' ? code : 'ORCHESTRATOR_ERROR')
    }
    if (!stopped) timer = setTimeout(poll, config.tickIntervalMs)
  }
  app.hooks.hook('close', () => {
    stopped = true
    if (timer) clearTimeout(timer)
    void orchestrator.shutdown().finally(() => lease.disconnect())
  })
  void poll()
})
