import type { Prisma, Player } from '@prisma/client'
import { adjustUserWallet } from './walletService'
import { prisma } from '../db/client'
import { applyRatingChange, calculateTableRatingChange, calculateZeroSumTableRatingDeltas, type RatingPotResult } from '../../app/utils/ratingCalculations'

type Tx = Prisma.TransactionClient

export const ACHIEVEMENTS = [
  { code: 'first_hand', title: 'За столом', description: 'Участие в первой раздаче', icon: '🎴', rarity: 'common', ratingReward: 3, moneyReward: 100 },
  { code: 'first_win', title: 'Первая победа', description: 'Первая победа за покерным столом', icon: '🏆', rarity: 'common', ratingReward: 8, moneyReward: 250 },
  { code: 'five_wins', title: 'Пять побед', description: 'Пять выигранных раздач', icon: '🖐️', rarity: 'uncommon', ratingReward: 12, moneyReward: 500 },
  { code: 'ten_wins', title: 'Десять побед', description: 'Десять выигранных раздач', icon: '🔟', rarity: 'rare', ratingReward: 20, moneyReward: 1000 },
  { code: 'three_win_streak', title: 'На ходу', description: 'Три победы подряд', icon: '🔥', rarity: 'rare', ratingReward: 15, moneyReward: 750 },
  { code: 'five_win_streak', title: 'Горячая серия', description: 'Пять побед подряд', icon: '⚡', rarity: 'epic', ratingReward: 30, moneyReward: 1500 },
  { code: 'split_win', title: 'Точный делёж', description: 'Победа в раздельном банке', icon: '⚖️', rarity: 'uncommon', ratingReward: 6, moneyReward: 300 },
  { code: 'all_in_win', title: 'Ва-банк', description: 'Победа в раздаче после all-in', icon: '💎', rarity: 'rare', ratingReward: 10, moneyReward: 500 },
  { code: 'careful_player', title: 'Хладнокровный', description: 'Победа после аккуратной игры без all-in', icon: '🧊', rarity: 'rare', ratingReward: 8, moneyReward: 400 },
  { code: 'bold_player', title: 'Смелый ход', description: 'Победа после повышения', icon: '♠️', rarity: 'uncommon', ratingReward: 6, moneyReward: 300 },
  { code: 'balance_50000', title: 'Золотой стек', description: 'Баланс достиг 50 000', icon: '🪙', rarity: 'rare', ratingReward: 10, moneyReward: 500 },
  { code: 'balance_100000', title: 'Большой стек', description: 'Баланс достиг 100 000', icon: '👑', rarity: 'epic', ratingReward: 20, moneyReward: 1000 },
  { code: 'balance_500000', title: 'Полмиллиона', description: 'Баланс достиг 500 000', icon: '💰', rarity: 'legendary', ratingReward: 35, moneyReward: 2500 },
  { code: 'balance_1000000', title: 'Миллионер', description: 'Баланс достиг 1 000 000', icon: '🌟', rarity: 'legendary', ratingReward: 50, moneyReward: 5000 },
  { code: 'comeback', title: 'Камбэк', description: 'Победа после трёх проигранных раздач', icon: '🔄', rarity: 'epic', ratingReward: 15, moneyReward: 750 },
  { code: 'prediction_hat_trick', title: 'Депай хату', description: 'Три раза подряд угадать победителя раздачи', icon: '🏠', rarity: 'rare', ratingReward: 20, moneyReward: 1000 },
  { code: 'busted_at_table', title: 'Раздавай, прошмандовка...', description: 'Впервые проиграть весь стек за одним столом', icon: '🕳️', rarity: 'rare', ratingReward: 12, moneyReward: 500 },
  { code: 'ramzan_kadyrov', title: 'Рамзан Кадыров', description: 'Открыты все остальные достижения', icon: '🖕', rarity: 'legendary', ratingReward: 100, moneyReward: 10000 }
  ,{ code: 'telegram_subscriber', title: 'Взломан мошенниками', description: 'Подписка на информативного Telegram-бота Poker Dealer', icon: '📲', rarity: 'rare', ratingReward: 0, moneyReward: 15000 }
] as const

const COMPLETION_ACHIEVEMENT = 'ramzan_kadyrov'

export async function notifyAchievementAward(tx: Tx, userId: string, achievement: { code: string; title: string; description: string }) {
  const recipient = await tx.user.findUnique({ where: { id: userId }, select: { username: true } })
  if (!recipient) return
  const queued = await tx.achievementNotification.createMany({ data: [{ userId, code: achievement.code, text: `🏆 Новая ачивка\nПользователь: ${recipient.username}\nАчивка: ${achievement.title}\nЗа что: ${achievement.description}` }], skipDuplicates: true })
  return queued.count === 1
}

export async function ensureAchievementDefinitions(tx?: Tx) {
  const client = tx || prisma
  for (const item of ACHIEVEMENTS) await client.achievement.upsert({ where: { code: item.code }, create: item, update: item })
}

export async function unlockAchievement(tx: Tx, userId: string, code: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`
  const definition = await tx.achievement.findUniqueOrThrow({ where: { code } })
  if (code === 'telegram_subscriber') {
    const historicalGrant = await tx.achievementNotification.findUnique({
      where: { userId_code: { userId, code } },
      select: { id: true }
    })
    if (historicalGrant) return false
  }
  const created = await tx.userAchievement.createMany({ data: [{ userId, achievementId: definition.id }], skipDuplicates: true })
  if (!created.count) return false
  const firstGrant = await notifyAchievementAward(tx, userId, definition)
  if (code === 'telegram_subscriber' && !firstGrant) return false
  if (definition.ratingReward) await tx.user.update({ where: { id: userId }, data: { tableRating: { increment: definition.ratingReward } } })
  if (definition.moneyReward) await adjustUserWallet(tx, { userId, delta: BigInt(definition.moneyReward), entryType: 'ACHIEVEMENT_REWARD', idempotencyKey: `achievement:${userId}:${code}`, metadata: { code, title: definition.title } })
  if (code !== COMPLETION_ACHIEVEMENT) {
    const requiredCodes = ACHIEVEMENTS.filter(item => item.code !== COMPLETION_ACHIEVEMENT).map(item => item.code)
    const unlockedRequired = await tx.userAchievement.count({ where: { userId, achievement: { code: { in: requiredCodes } } } })
    if (unlockedRequired === requiredCodes.length) await unlockAchievement(tx, userId, COMPLETION_ACHIEVEMENT)
  }
  return true
}

export async function unlockBalanceAchievements(tx: Tx, userId: string, balance: bigint) {
  await ensureAchievementDefinitions(tx)
  const codes: string[] = []
  if (balance >= 50_000n) codes.push('balance_50000')
  if (balance >= 100_000n) codes.push('balance_100000')
  if (balance >= 500_000n) codes.push('balance_500000')
  if (balance >= 1_000_000n) codes.push('balance_1000000')
  for (const code of codes) await unlockAchievement(tx, userId, code)
}

export async function updateTableRatingAndAchievements(tx: Tx, handId: string, players: Player[], winnerIds: string[], ratingPots?: readonly RatingPotResult[]) {
  await ensureAchievementDefinitions(tx)
  const eligible = players.filter(player => player.userId && player.memberId && player.status !== 'waiting' && player.status !== 'out')
  const ratingUsers = await tx.user.findMany({ where: { id: { in: eligible.map(player => player.userId!) } }, select: { id: true, tableRating: true } })
  const ratingDeltas = calculateZeroSumTableRatingDeltas(
    eligible.map(player => player.userId!),
    new Map(ratingUsers.map(user => [user.id, user.tableRating])),
    ratingPots ?? [{ amount: 1, contributorPlayerIds: eligible.map(player => player.userId!), eligiblePlayerIds: eligible.map(player => player.userId!), winnerIds: winnerIds.map(id => players.find(player => player.id === id)?.userId).filter((id): id is string => Boolean(id)) }]
  )
  const actions = await tx.playerAction.findMany({ where: { handId, status: { in: ['applied', 'approved'] } }, orderBy: { createdAt: 'asc' } })
  for (const player of eligible) {
    const userId = player.userId!
    const ownActions = actions.filter(action => action.playerId === player.id)
    const won = winnerIds.includes(player.id)
    const split = won && winnerIds.length > 1
    const hadRaise = ownActions.some(action => action.type === 'raise' || action.type === 'bet')
    const hadAllIn = ownActions.some(action => action.type === 'all-in')
    const { reason } = calculateTableRatingChange({
      won,
      split,
      folded: player.status === 'folded',
      hadAction: ownActions.length > 0,
      hadRaise,
      hadAllIn
    })
    const delta = ratingDeltas.get(userId) ?? 0
    const event = await tx.tableRatingEvent.createMany({ data: [{ userId, handId, delta, reason }], skipDuplicates: true })
    if (!event.count) continue
    const account = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true, tableRating: true, tableHandsWon: true, tableCurrentStreak: true, tableBestStreak: true } })
    const streak = won ? account.tableCurrentStreak + 1 : 0
    const wins = account.tableHandsWon + (won ? 1 : 0)
    await tx.user.update({
      where: { id: userId },
      data: {
        tableRating: applyRatingChange(account.tableRating, delta),
        tableHandsPlayed: { increment: 1 },
        tableHandsWon: { increment: won ? 1 : 0 },
        tableCurrentStreak: streak,
        tableBestStreak: Math.max(account.tableBestStreak, streak)
      }
    })
    const latestRatingEvents = await tx.tableRatingEvent.findMany({ where: { userId }, select: { delta: true }, orderBy: { createdAt: 'desc' }, take: 4 })
    const comeback = won && latestRatingEvents.length >= 4 && latestRatingEvents.slice(1, 4).every(item => item.delta < 0)
    const balance = account.balance
    const codes = ['first_hand']
    if (won) codes.push('first_win')
    if (wins >= 5) codes.push('five_wins')
    if (wins >= 10) codes.push('ten_wins')
    if (streak >= 3) codes.push('three_win_streak')
    if (streak >= 5) codes.push('five_win_streak')
    if (split) codes.push('split_win')
    if (won && hadAllIn) codes.push('all_in_win')
    if (won && !hadAllIn) codes.push('careful_player')
    if (won && hadRaise) codes.push('bold_player')
    if (comeback) codes.push('comeback')
    if (balance >= 50000) codes.push('balance_50000')
    if (balance >= 100000) codes.push('balance_100000')
    if (balance >= 500000) codes.push('balance_500000')
    if (balance >= 1000000) codes.push('balance_1000000')
    for (const code of codes) await unlockAchievement(tx, userId, code)
  }
}

export async function grantAllAchievementsToAdmin(tx: Tx, userId: string) {
  await ensureAchievementDefinitions(tx)
  for (const item of ACHIEVEMENTS) await unlockAchievement(tx, userId, item.code)
}
