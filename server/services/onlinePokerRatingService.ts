import { prisma } from '../db/client'
import { applyRatingChange, calculateTableRatingChange } from '../../app/utils/ratingCalculations'
import type { OnlineRoomState } from '../utils/pokerOnlineRoom'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Idempotently records a finalized ONLINE hand into the same User rating and
 * statistics used by the ordinary leaderboard. No wallet/achievement reward
 * is issued by this result recorder.
 */
export async function recordFinalizedOnlinePokerHand(state: OnlineRoomState): Promise<number> {
  const table = state.pokerTable
  const hand = table.currentHand
  const result = table.finalizedHand
  if (!hand || !result || table.finalizedHandId !== hand.handId || result.handId !== hand.handId) return 0

  const winnerIds = new Set(result.players.filter(player => player.payout > 0).map(player => player.playerId))
  const splitWinnerIds = new Set(result.pots.filter(pot => pot.split).flatMap(pot => pot.winnerIds))
  return prisma.$transaction(async tx => {
    let recorded = 0
    for (const player of [...hand.players].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
      if (!UUID.test(player.playerId)) continue
      const won = winnerIds.has(player.playerId)
      const { delta, reason } = calculateTableRatingChange({
        won,
        split: won && splitWinnerIds.has(player.playerId),
        folded: player.status === 'FOLDED',
        hadAction: player.lastAction !== null,
        hadRaise: player.lastAction === 'bet' || player.lastAction === 'raise',
        hadAllIn: player.lastAction === 'all-in'
      })
      const alreadyRecorded = await tx.onlinePokerRatingEvent.findUnique({
        where: { userId_handId: { userId: player.playerId, handId: hand.handId } },
        select: { id: true }
      })
      if (alreadyRecorded) continue
      await tx.$queryRaw`SELECT id FROM users WHERE id=${player.playerId}::uuid FOR UPDATE`
      const created = await tx.onlinePokerRatingEvent.createMany({
        data: [{ userId: player.playerId, handId: hand.handId, delta, reason }],
        skipDuplicates: true
      })
      if (created.count !== 1) continue
      await tx.tableRatingEvent.create({ data: { userId: player.playerId, handId: null, delta, reason } })

      const account = await tx.user.findUniqueOrThrow({
        where: { id: player.playerId },
        select: { tableRating: true, tableHandsWon: true, tableCurrentStreak: true, tableBestStreak: true }
      })
      const streak = won ? account.tableCurrentStreak + 1 : 0
      await tx.user.update({
        where: { id: player.playerId },
        data: {
          tableRating: applyRatingChange(account.tableRating, delta),
          tableHandsPlayed: { increment: 1 },
          tableHandsWon: { increment: won ? 1 : 0 },
          tableCurrentStreak: streak,
          tableBestStreak: Math.max(account.tableBestStreak, streak)
        }
      })
      recorded += 1
    }
    return recorded
  })
}
