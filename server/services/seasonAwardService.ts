import type { Prisma, Season } from '@prisma/client'

type Tx = Prisma.TransactionClient
type Metrics = Record<string, any> & { userId: string; balance: number; tableRating: number; predictionRating: number; handsPlayed: number; handsWon: number; predictionCount: number; predictionWins: number; bestWinStreak: number }

export const SEASON_CATEGORY_META = {
  balance: { label: 'баланс', icon: '💰' },
  tableRating: { label: 'рейтинг', icon: '♠️' },
  predictionWins: { label: 'прогнозы', icon: '🎯' },
  predictionPayout: { label: 'ставки', icon: '📈' },
  bestWinStreak: { label: 'серия побед', icon: '🔥' },
  winRate: { label: 'надёжность', icon: '🥷' },
  handsPlayed: { label: 'активность', icon: '🃏' }
} as const

export const SEASON_CATEGORIES = Object.keys(SEASON_CATEGORY_META) as Array<keyof typeof SEASON_CATEGORY_META>

const asNumber = (value: unknown) => Number(value || 0)
const dayKey = (date: Date) => date.toISOString().slice(0, 10)

export async function collectSeasonMetrics(tx: Tx, season: Season, userId: string, base: Record<string, any>): Promise<Metrics> {
  const range = { gte: season.startsAt, lt: season.endsAt }
  const [ratingEvents, predictionEvents, handResults, actions, bets, roomAccounts, eliminated, walletEntries, tokenBets, miniGames, crashBets] = await Promise.all([
    tx.tableRatingEvent.findMany({ where: { userId, createdAt: range }, select: { createdAt: true, handId: true } }),
    tx.predictionRatingEvent.findMany({ where: { userId, createdAt: range }, select: { createdAt: true } }),
    tx.handResult.findMany({ where: { player: { userId }, hand: { finishedAt: range, status: 'finished' } }, select: { amountWon: true, handId: true } }),
    tx.playerAction.findMany({ where: { player: { userId }, hand: { finishedAt: range, status: 'finished' }, status: { in: ['applied', 'approved'] } }, select: { amount: true, type: true, handId: true, createdAt: true } }),
    tx.predictionBet.findMany({ where: { member: { accounts: { some: { userId } } }, settledAt: range, status: { in: ['won', 'lost'] } }, select: { status: true, grossPayout: true, netProfit: true, candidatePlayerId: true, acceptedOddsHundredths: true, riskPercent: true, settledAt: true }, orderBy: [{ settledAt: 'asc' }, { id: 'asc' }] }),
    tx.roomMemberAccount.findMany({ where: { userId, createdAt: { lt: season.endsAt }, OR: [{ endedAt: null }, { endedAt: { gte: season.startsAt } }] }, select: { member: { select: { roomId: true } } } }),
    tx.roomMember.count({ where: { eliminatedAt: range, accounts: { some: { userId } } } }),
    tx.walletLedgerEntry.findMany({ where: { wallet: { userId }, createdAt: range, entryType: { notIn: ['BUY_IN_DEBIT', 'TOP_UP_DEBIT', 'ROOM_STACK_RETURN', 'TABLE_CASH_OUT', 'MINES_BANK_RESERVE', 'MINES_BANK_SETTLEMENT'] } }, select: { balanceAfter: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    tx.tokenPrediction.findMany({ where: { userId, status: { in: ['WON','LOST'] }, round: { settledAt: range } }, include: { round: true }, orderBy: { round: { settledAt: 'asc' } } }),
    tx.miniGameSession.findMany({ where: { userId, finishedAt: range, status: { not: 'ACTIVE' } }, select: { payout: true, stake: true, finishedAt: true } }),
    tx.crashBet.findMany({ where: { userId, round: { phase: 'crashed', updatedAt: range } }, select: { payout: true, stake: true } })
  ])

  const winningHands = new Set(handResults.map(item => item.handId))
  const totalWon = handResults.reduce((sum, item) => sum + item.amountWon, 0) + [...miniGames, ...crashBets].reduce((sum,item)=>sum+Math.max(0,Number(item.payout)-Number(item.stake)),0)
  const totalLost = actions.filter(item => !winningHands.has(item.handId)).reduce((sum, item) => sum + Math.max(0, item.amount), 0) + [...miniGames, ...crashBets].reduce((sum,item)=>sum+Math.max(0,Number(item.stake)-Number(item.payout)),0)
  const largeBets = actions.filter(item => ['bet', 'raise', 'all-in'].includes(item.type) && item.amount >= 1_000).length
  const predictionPayout = bets.reduce((sum, item) => sum + Number(item.grossPayout), 0) + tokenBets.reduce((sum,item)=>sum+Number(item.payout),0)
  const totalPredictionProfit = bets.reduce((sum, item) => sum + Number(item.netProfit), 0) + tokenBets.reduce((sum,item)=>sum+Number(item.payout),0)
  const successfulBets = bets.filter(item => item.status === 'won')
  let sameTargetWinStreak = 0
  let currentTarget = ''
  let currentTargetStreak = 0
  for (const bet of [...bets, ...tokenBets.map(p=>({ status: p.status === 'WON' ? 'won' : 'lost', candidatePlayerId: p.candidateId, settledAt: p.round.settledAt }))].sort((a,b)=>Number(a.settledAt)-Number(b.settledAt))) {
    if (bet.status === 'won') {
      if (bet.candidatePlayerId === currentTarget) currentTargetStreak += 1
      else { currentTarget = bet.candidatePlayerId; currentTargetStreak = 1 }
      sameTargetWinStreak = Math.max(sameTargetWinStreak, currentTargetStreak)
    } else { currentTarget = ''; currentTargetStreak = 0 }
  }
  const activeDays = new Set([...ratingEvents.map(item => dayKey(item.createdAt)), ...predictionEvents.map(item => dayKey(item.createdAt))]).size
  const roomIds = new Set(roomAccounts.map(item => item.member.roomId))
  let dippedBelow5000 = false
  let comeback = false
  for (const entry of walletEntries) {
    if (entry.balanceAfter < 5_000n) dippedBelow5000 = true
    if (dippedBelow5000 && entry.balanceAfter >= 50_000n) comeback = true
  }

  const handsPlayed = asNumber(base.handsPlayed)
  const handsWon = asNumber(base.handsWon)
  const predictionCount = asNumber(base.predictionCount)
  const predictionWins = asNumber(base.predictionWins)
  return {
    ...base, userId,
    balance: asNumber(base.balance), tableRating: asNumber(base.tableRating), predictionRating: asNumber(base.predictionRating),
    handsPlayed, handsWon, predictionCount, predictionWins, bestWinStreak: asNumber(base.bestWinStreak),
    winRate: handsPlayed >= 10 ? Number((handsWon * 100 / handsPlayed).toFixed(4)) : 0,
    predictionSuccessRate: predictionCount >= 3 ? Number((predictionWins * 100 / predictionCount).toFixed(4)) : 0,
    totalWon, totalLost, largeBets, predictionPayout, totalPredictionProfit,
    maxWinningOdds: successfulBets.reduce((max, item) => Math.max(max, asNumber(item.acceptedOddsHundredths) / 100), 0),
    highRiskPredictionWin: successfulBets.some(item => item.riskPercent > 50),
    sameTargetWinStreak, activeDays, roomsJoined: roomIds.size, bustedAtTable: eliminated > 0, comeback
  }
}

function rank(rows: Metrics[], key: string) {
  const eligible = rows.filter(row => {
    if (key === 'balance') return true
    if (key === 'tableRating' || key === 'handsPlayed') return row.handsPlayed > 0
    if (key === 'winRate') return row.handsPlayed >= 10
    if (key === 'predictionWins') return row.predictionCount > 0
    if (key === 'predictionPayout') return row.predictionPayout > 0
    if (key === 'bestWinStreak') return row.bestWinStreak > 0
    return asNumber(row[key]) > 0
  })
  const sorted = [...eligible].sort((a, b) => asNumber(b[key]) - asNumber(a[key]) || (key === 'tableRating' ? b.handsPlayed - a.handsPlayed : 0) || (key === 'predictionWins' ? b.predictionSuccessRate - a.predictionSuccessRate : 0) || a.userId.localeCompare(b.userId))
  let place = 0
  let previousKey = ''
  return sorted.map((row, index) => {
    const tieKey = key === 'tableRating' ? `${row[key]}:${row.handsPlayed}` : key === 'predictionWins' ? `${row[key]}:${row.predictionSuccessRate}` : `${row[key]}`
    if (tieKey !== previousKey) place = index + 1
    previousKey = tieKey
    return { row, place, tieKey }
  }).filter(item => item.place <= 10)
}

async function createReward(tx: Tx, season: Season, row: Metrics, data: { rewardType: string; category: string; title: string; description: string; icon: string; rarity: string; place?: number | null }) {
  await tx.seasonReward.upsert({
    where: { seasonId_userId_rewardType_category: { seasonId: season.id, userId: row.userId, rewardType: data.rewardType, category: data.category } },
    create: { seasonId: season.id, userId: row.userId, ...data },
    update: { title: data.title, description: data.description, icon: data.icon, rarity: data.rarity, place: data.place }
  })
}

export async function buildSeasonAwards(tx: Tx, season: Season, rows: Metrics[]) {
  const placements = new Map<string, Map<string, number>>()
  const placementCandidates = new Map<string, Array<{ rewardType: string; category: string; title: string; description: string; icon: string; rarity: string; place?: number | null }>>()
  for (const category of SEASON_CATEGORIES) {
    const categoryRanks = rank(rows, category)
    const byUser = new Map<string, number>()
    placements.set(category, byUser)
    for (const { row, place, tieKey } of categoryRanks) {
      byUser.set(row.userId, place)
      await tx.seasonLeaderboard.upsert({
        where: { seasonId_category_userId: { seasonId: season.id, category, userId: row.userId } },
        create: { seasonId: season.id, userId: row.userId, category, place, value: String(row[category] || 0), tieKey },
        update: { place, value: String(row[category] || 0), tieKey }
      })
      const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🎖️'
      const rarity = place === 1 ? 'legendary' : place === 2 ? 'epic' : place === 3 ? 'rare' : 'uncommon'
      const label = SEASON_CATEGORY_META[category].label
      const candidates = placementCandidates.get(row.userId) || []
      candidates.push({ rewardType: 'placement', category, place, title: `Лидер сезона #${place} — ${label}`, description: `Сезон ${season.number} · место ${place} в категории «${label}»`, icon: medal, rarity })
      placementCandidates.set(row.userId, candidates)
    }
  }

  const isTop = (row: Metrics, key: string, filter: (item: Metrics) => boolean = () => true) => {
    const eligible = rows.filter(filter)
    if (!eligible.length) return false
    return asNumber(row[key]) === Math.max(...eligible.map(item => asNumber(item[key])))
  }
  const funniest = [
    { code: 'chief_banker', title: 'Главный банкир сезона', reason: 'Первое место по итоговому балансу', icon: '🏦', rarity: 'legendary', ok: (r: Metrics) => placements.get('balance')?.get(r.userId) === 1 },
    { code: 'walking_wallet', title: 'Кошелёк на ножках', reason: 'Баланс увеличен минимум в пять раз', icon: '👛', rarity: 'epic', ok: (r: Metrics) => r.balance >= 250_000 },
    { code: 'crypto_tycoon', title: 'Криптовалютный магнат', reason: 'Сезонный баланс достиг 500 000', icon: '🪙', rarity: 'legendary', ok: (r: Metrics) => r.balance >= 500_000 },
    { code: 'money_vacuum', title: 'Денежный пылесос', reason: 'Выиграно больше всех игровых фишек', icon: '🧹', rarity: 'epic', ok: (r: Metrics) => r.totalWon > 0 && isTop(r, 'totalWon', x => x.totalWon > 0) },
    { code: 'bad_investor', title: 'Неудачный инвестор', reason: 'Потеряно не менее 90% стартового баланса при продолжении игры', icon: '📉', rarity: 'rare', ok: (r: Metrics) => r.balance <= 5_000 && r.handsPlayed > 0 },
    { code: 'table_king', title: 'Король стола', reason: 'Первое место по рейтингу игры', icon: '♛', rarity: 'legendary', ok: (r: Metrics) => placements.get('tableRating')?.get(r.userId) === 1 },
    { code: 'table_sheriff', title: 'Шериф стола', reason: 'Выиграно больше всех раздач', icon: '⭐', rarity: 'epic', ok: (r: Metrics) => r.handsWon > 0 && isTop(r, 'handsWon', x => x.handsWon > 0) },
    { code: 'silent_killer', title: 'Тихий убийца', reason: 'Лучший процент побед при минимуме крупных ставок', icon: '🥷', rarity: 'epic', ok: (r: Metrics) => r.handsPlayed >= 10 && r.userId === [...rows].filter(x => x.handsPlayed >= 10).sort((a, b) => b.winRate - a.winRate || a.largeBets - b.largeBets)[0]?.userId },
    { code: 'brain_not_luck', title: 'Мозг, а не удача', reason: 'Рейтинг игры превысил 1 500', icon: '🧠', rarity: 'legendary', ok: (r: Metrics) => r.tableRating > 1_500 },
    { code: 'almost_grandmaster', title: 'Почти гроссмейстер', reason: 'Попадание в топ-10 по рейтингу игры', icon: '♟️', rarity: 'rare', ok: (r: Metrics) => r.handsPlayed > 0 && Boolean(placements.get('tableRating')?.get(r.userId)) },
    { code: 'chief_gambler', title: 'Главный лудик сезона', reason: 'Выиграно больше всех прогнозов', icon: '🎰', rarity: 'legendary', ok: (r: Metrics) => r.predictionWins > 0 && isTop(r, 'predictionWins', x => x.predictionWins > 0) },
    { code: 'district_oracle', title: 'Гадалка районного масштаба', reason: 'Лучший процент успешных прогнозов', icon: '🔮', rarity: 'epic', ok: (r: Metrics) => r.predictionCount >= 3 && isTop(r, 'predictionSuccessRate', x => x.predictionCount >= 3) },
    { code: 'odds_hunter', title: 'Охотник за коэффициентами', reason: 'Максимальная сумма выигрыша на прогнозах', icon: '🏹', rarity: 'epic', ok: (r: Metrics) => r.predictionPayout > 0 && isTop(r, 'predictionPayout', x => x.predictionPayout > 0) },
    { code: 'bet_on_beauty', title: 'Ставлю на этого красавчика', reason: 'Десять успешных прогнозов подряд на одного игрока', icon: '😍', rarity: 'legendary', ok: (r: Metrics) => r.sameTargetWinStreak >= 10 },
    { code: 'odds_maniac', title: 'Коэффициентный маньяк', reason: 'Выигран прогноз с коэффициентом 5.00 или выше', icon: '🤪', rarity: 'epic', ok: (r: Metrics) => r.maxWinningOdds >= 5 },
    { code: 'all_on_favorite', title: 'Всё на фаворита', reason: 'Выигран прогноз с риском более 50% баланса', icon: '💥', rarity: 'legendary', ok: (r: Metrics) => r.highRiskPredictionWin },
    { code: 'unstoppable', title: 'Не остановить', reason: 'Самая длинная серия побед сезона', icon: '🔥', rarity: 'legendary', ok: (r: Metrics) => r.bestWinStreak > 0 && isTop(r, 'bestWinStreak', x => x.bestWinStreak > 0) },
    { code: 'comeback_century', title: 'Камбэк века', reason: 'Баланс восстановлен после падения ниже 5 000', icon: '🚀', rarity: 'legendary', ok: (r: Metrics) => r.comeback },
    { code: 'last_survivor', title: 'Последний выживший', reason: 'Сыграно больше всех раздач', icon: '🧟', rarity: 'epic', ok: (r: Metrics) => r.handsPlayed > 0 && isTop(r, 'handsPlayed', x => x.handsPlayed > 0) },
    { code: 'table_regular', title: 'Свой человек за столом', reason: 'Участие минимум в десяти комнатах', icon: '🤝', rarity: 'rare', ok: (r: Metrics) => r.roomsJoined >= 10 },
    { code: 'marathoner', title: 'Марафонец', reason: 'Раздачи сыграны во все десять дней сезона', icon: '🏃', rarity: 'legendary', ok: (r: Metrics) => r.activeDays >= 10 },
    { code: 'deal_it', title: 'Раздавай, прошмандовка…', reason: 'Баланс полностью проигран за одним столом', icon: '🕳️', rarity: 'epic', ok: (r: Metrics) => r.bustedAtTable }
  ]

  for (const row of rows) {
    const candidates = [...(placementCandidates.get(row.userId) || [])]
    for (const award of funniest) if (award.ok(row)) candidates.push({ rewardType: 'achievement', category: award.code, title: award.title, description: `${award.reason} · сезон ${season.number}`, icon: award.icon, rarity: award.rarity, place: null })
    const rarityScore: Record<string, number> = { legendary: 4, epic: 3, rare: 2, uncommon: 1, common: 0 }
    candidates.sort((a, b) => (rarityScore[b.rarity] || 0) - (rarityScore[a.rarity] || 0) || Number(b.rewardType === 'achievement') - Number(a.rewardType === 'achievement') || (a.place || 99) - (b.place || 99))
    const best = candidates[0] || { rewardType: 'participant', category: 'season', title: `Пустышка ${season.number} сезона`, description: `Участник сезона ${season.number}`, icon: '🪹', rarity: 'common', place: null }
    await createReward(tx, season, row, best)
  }
}
