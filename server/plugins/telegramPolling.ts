import { ProxyAgent } from 'undici'
import { handleTelegramUpdate } from '../services/telegramService'

export default defineNitroPlugin(() => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const proxyUrl = process.env.TELEGRAM_PROXY_URL
  if (!token) return

  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  let offset = 0
  let stopped = false

  const callTelegram = async (method: string, body: Record<string, unknown>) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(dispatcher ? { dispatcher } : {})
    } as RequestInit & { dispatcher?: ProxyAgent })
    if (!response.ok) throw new Error(`Telegram API ${response.status}`)
    return response.json() as Promise<{ ok: boolean; result?: any }>
  }

  const poll = async () => {
    try {
      const result = await callTelegram('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] })
      for (const update of result.result || []) {
        offset = Math.max(offset, Number(update.update_id) + 1)
        const reply = await handleTelegramUpdate(update)
        if (reply?.method === 'sendMessage') await callTelegram('sendMessage', reply)
      }
    } catch (error) {
      console.error('[telegram polling]', error instanceof Error ? error.message : error)
    }
    if (!stopped) setTimeout(poll, 1000)
  }

  void callTelegram('deleteWebhook', { drop_pending_updates: false }).catch(() => undefined)
  void poll()
  void useNitroApp().hooks.hook('close', async () => {
    stopped = true
    await dispatcher?.close()
  })
})
