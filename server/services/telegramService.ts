import { createHash, randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { ProxyAgent } from 'undici'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { ensureAchievementDefinitions, unlockAchievement } from './achievementService'

type TelegramUpdate = { message?: { chat: { id: number | string; type?: string }; from?: { id: number | string; username?: string; first_name?: string }; text?: string } }
type TelegramWebhookReply = { method: 'sendMessage'; chat_id: number | string; text: string }
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
const botToken = () => process.env.TELEGRAM_BOT_TOKEN || ''
const channelChatId = () => process.env.TELEGRAM_CHANNEL_CHAT_ID || ''
const telegramProxy = () => process.env.TELEGRAM_PROXY_URL ? new ProxyAgent(process.env.TELEGRAM_PROXY_URL) : undefined

async function telegram(method: string, body: Record<string, unknown>) {
  const token = botToken()
  if (!token) return null
  const dispatcher = telegramProxy()
  try {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(dispatcher ? { dispatcher } : {}) } as RequestInit & { dispatcher?: ProxyAgent })
  if (!response.ok) throw new Error(`Telegram API ${response.status}`)
  const payload = await response.json() as { ok: boolean; description?: string; result?: unknown }
  if (!payload.ok) throw new Error(`Telegram API rejected request${payload.description ? `: ${payload.description}` : ''}`)
  return payload
  } finally { await dispatcher?.close() }
}

export async function createTelegramLink(rawToken: string) {
  const auth = await verifyUserAuthToken(rawToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  if (!botToken()) throw createError({ statusCode: 503, statusMessage: 'Telegram-бот пока не настроен' })
  const value = `tg_${randomBytes(24).toString('base64url')}`
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${auth.userId}::uuid FOR UPDATE`
    await tx.telegramLinkToken.deleteMany({ where: { userId: auth.userId, usedAt: null } })
    await tx.telegramLinkToken.create({ data: { userId: auth.userId, tokenHash: tokenHash(value), expiresAt: new Date(Date.now() + 15 * 60 * 1000) } })
  })
  return { url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'Pockerkiruhakbot'}?start=${value}`, expiresIn: 900 }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const message = update.message
  const text = message?.text || ''
  if (!message || !text.startsWith('/start')) return { ok: true, ignored: true }
  if (message.chat.type !== 'private' || !message.from || String(message.chat.id) !== String(message.from.id)) return { ok: true, ignored: true }
  const raw = text.slice('/start'.length).trim()
  if (!raw) {
    return {
      method: 'sendMessage',
      chat_id: message.chat.id,
      text: 'Чтобы подключить Telegram к аккаунту, откройте настройки на сайте Poker Dealer и нажмите «Подключить Telegram». Затем нажмите кнопку Start в открывшемся диалоге.'
    } satisfies TelegramWebhookReply
  }
  const link = await prisma.telegramLinkToken.findFirst({ where: { tokenHash: tokenHash(raw), usedAt: null, expiresAt: { gt: new Date() } } })
  if (!link) {
    return { method: 'sendMessage', chat_id: message.chat.id, text: 'Ссылка устарела. Создайте новую ссылку в настройках Poker Dealer.' } satisfies TelegramWebhookReply
  }
  const from = message.from
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${link.userId}::uuid FOR UPDATE`
    const user = await tx.user.findUnique({ where: { id: link.userId } })
    if (!user || user.deletedAt || user.blockedAt) return null
    const consumed = await tx.telegramLinkToken.updateMany({ where: { id: link.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } })
    if (!consumed.count) return null
    await tx.telegramSubscription.upsert({ where: { userId: link.userId }, create: { userId: link.userId, chatId: String(message.chat.id), telegramUserId: String(from?.id || message.chat.id), username: from?.username, firstName: from?.first_name }, update: { chatId: String(message.chat.id), telegramUserId: String(from?.id || message.chat.id), username: from?.username, firstName: from?.first_name, isActive: true, lastSeenAt: new Date() } })
    await ensureAchievementDefinitions(tx)
    return { awarded: await unlockAchievement(tx, link.userId, 'telegram_subscriber') }
  })
  if (!result) return { ok: true, ignored: true }
  return {
    method: 'sendMessage',
    chat_id: message.chat.id,
    text: result.awarded ? 'Telegram подключён. Вам начислены достижение и 15 000 фишек.' : 'Telegram подключён. Достижение уже получено ранее, повторная награда не начисляется.'
  } satisfies TelegramWebhookReply
}

export async function telegramStatus(rawToken: string) {
  const auth = await verifyUserAuthToken(rawToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return prisma.telegramSubscription.findUnique({ where: { userId: auth.userId }, select: { isActive: true, subscribedAt: true, username: true, firstName: true } })
}

export async function unlinkTelegram(rawToken: string) {
  const auth = await verifyUserAuthToken(rawToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${auth.userId}::uuid FOR UPDATE`
    await tx.telegramLinkToken.deleteMany({ where: { userId: auth.userId, usedAt: null } })
    await tx.telegramSubscription.updateMany({ where: { userId: auth.userId }, data: { isActive: false } })
  })
  return { success: true }
}

export async function notifyTelegram(userId: string, text: string) {
  const subscription = await prisma.telegramSubscription.findUnique({ where: { userId } })
  if (!subscription?.isActive || !botToken()) return false
  try {
    await telegram('sendMessage', { chat_id: subscription.chatId, text, disable_web_page_preview: true })
    await prisma.telegramSubscription.updateMany({ where: { id: subscription.id, isActive: true }, data: { lastSeenAt: new Date() } })
    return true
  } catch (error) {
    console.error('[telegram notification]', { userId, chatId: subscription.chatId, error: error instanceof Error ? error.message : String(error) })
    // Keep the subscription visible in the profile. A transient proxy or
    // Telegram outage must not silently make the user reconnect the bot.
    return false
  }
}

export async function notifyUsersTelegram(userIds: string[], text: string) { return Promise.all(userIds.map(userId => notifyTelegram(userId, text))) }

export async function notifyTelegramChannel(text: string) {
  const chatId = channelChatId()
  if (!chatId || !botToken()) return false
  try {
    await telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
    return true
  } catch (error) {
    console.error('[telegram channel notification]', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
