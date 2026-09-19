import { randomUUID } from 'node:crypto'
import type { Hand, Player, PredictionBet, PredictionMarket, Prisma, ReentryRequest, Room, RoomMember } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { verifySecret } from './authService'
import { parseRoomSettings } from './roomService'
import { recordRoomLedger } from './walletService'
import { ensureAchievementDefinitions, unlockAchievement } from './achievementService'
import { toChipNumber } from '../utils/chips'
import {
  calculateBehaviorScores,
  calculatePredictionQuotes,
  calculateFixedPredictionQuotes,
  fixedPredictionPayout,
  requiredPredictionReserve,
  settleFixedPredictions,
  settlePredictionPool,
  type PredictionCandidateInput
} from '../../app/utils/predictionCalculations'
import { calculatePredictionRatingDelta, predictionRiskPercent } from '../../app/utils/predictionCalculations'
import { applyRatingChange } from '../../app/utils/ratingCalculations'
import type {
  DealerPredictionState,
  PredictionBetView,
  PredictionMarketView,
  PredictionViewerState,
  ReentryRequestView,
  RoomMemberSummary
} from '../../app/types/prediction'
import type { BettingState } from '../../app/utils/bettingRounds'

type Tx = Prisma.TransactionClient

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

async function lockMarket(tx: Tx, marketId: string) {
  await tx.$queryRaw`SELECT id FROM "prediction_markets" WHERE id = CAST(${marketId} AS uuid) FOR UPDATE`
  return tx.predictionMarket.findUniqueOrThrow({ where: { id: marketId } })
}

async function lockPredictionWallet(tx: Tx, memberId: string) {
  await tx.$queryRaw`SELECT id FROM "prediction_wallets" WHERE "member_id" = CAST(${memberId} AS uuid) FOR UPDATE`
  return tx.predictionWallet.findUnique({ where: { memberId } })
}

async function buildCandidateInputs(tx: Tx, handId: string, players: Player[]): Promise<PredictionCandidateInput[]> {
  const memberIds = players.flatMap(player => player.memberId ? [player.memberId] : [])
  const [stats, actions] = await Promise.all([
    tx.playerBehaviorStat.findMany({ where: { memberId: { in: memberIds } } }),
    tx.playerAction.findMany({ where: { handId, status: { in: ['applied', 'approved'] } }, orderBy: { appliedAt: 'asc' } })
  ])
  const statsByMember = new Map(stats.map(item => [item.memberId, item]))
  const actionsByPlayer = new Map<string, typeof actions>()
  for (const action of actions) actionsByPlayer.set(action.playerId, [...(actionsByPlayer.get(action.playerId) || []), action])

  return players.map(player => {
    const stat = player.memberId ? statsByMember.get(player.memberId) : undefined
    const playerActions = actionsByPlayer.get(player.id) || []
    return {
      playerId: player.id,
      playerName: player.name,
      seat: player.seat,
      stack: player.stack,
      currentBet: player.currentBet,
      totalCommitted: player.totalCommitted,
      status: player.status,
      actionTypes: playerActions.map(action => action.type),
      lastDecisionMs: playerActions.at(-1)?.decisionTimeMs ?? undefined,
      stats: stat ? {
        sampleSize: stat.sampleSize,
        opportunities: stat.opportunities,
        bets: stat.bets,
        raises: stat.raises,
        folds: stat.folds,
        allIns: stat.allIns,
        showdowns: stat.showdowns,
        mainPotWins: stat.mainPotWins,
        averageDecisionMs: stat.averageDecisionMs
      } : undefined
    }
  })
}

async function calculateCurrentQuotes(tx: Tx, room: Room, hand: Hand, players: Player[], market: PredictionMarket) {
  const settings = parseRoomSettings(room.settings)
  const candidates = await buildCandidateInputs(tx, hand.id, players)
  const scores = calculateBehaviorScores(candidates, {
    behaviorImpact: settings.predictions.behaviorImpact,
    bigBlind: settings.bigBlind || 10,
    includeDecisionTime: settings.predictions.includeDecisionTime
  })
  const bets = await tx.predictionBet.findMany({ where: { marketId: market.id, status: 'open' } })
  const stakeByPlayer = new Map<string, number>()
  for (const bet of bets) stakeByPlayer.set(bet.candidatePlayerId, (stakeByPlayer.get(bet.candidatePlayerId) || 0) + toChipNumber(bet.stake))
  const byId = new Map(candidates.map(candidate => [candidate.playerId, candidate]))
  const inputs = scores.map(score => ({
    ...score,
    playerName: byId.get(score.playerId)?.playerName || 'Игрок',
    seat: byId.get(score.playerId)?.seat || 0,
    realStake: stakeByPlayer.get(score.playerId) || 0
  }))
  const quotes = market.pricingMode === 'fixed_odds'
    ? calculateFixedPredictionQuotes(inputs, toChipNumber(market.quoteLiquidity!), (hand.bettingState as unknown as BettingState).street)
    : calculatePredictionQuotes(inputs, toChipNumber(market.liquidity))
  return { candidates, quotes }
}

async function persistQuoteRevision(tx: Tx, room: Room, hand: Hand, players: Player[], market: PredictionMarket, nextRevision: number) {
  const calculated = await calculateCurrentQuotes(tx, room, hand, players, market)
  await tx.predictionQuote.createMany({
    data: calculated.quotes.filter(quote => quote.available).map(quote => ({
      marketId: market.id,
      revision: nextRevision,
      candidatePlayerId: quote.playerId,
      realStake: BigInt(quote.realStake),
      virtualStake: BigInt(quote.virtualStake),
      modelProbability: quote.probability,
      odds: quote.odds,
      reasonCodes: json(quote.reasonCodes)
    }))
  })
  await tx.predictionMarket.update({
    where: { id: market.id },
    data: {
      revision: nextRevision,
      modelSnapshot: json({
        modelVersion: market.modelVersion,
        candidates: calculated.candidates,
        scores: calculated.quotes.map(quote => ({ playerId: quote.playerId, probability: quote.probability, reasonCodes: quote.reasonCodes }))
      })
    }
  })
}

// New hands use tokenPredictionService. Existing monetary markets can still settle.
export async function openPredictionMarketForHand(_tx: Tx, _room: Room, _hand: Hand, _players: Player[]) { return null }

export async function refreshPredictionMarketAfterAction(tx: Tx, room: Room, hand: Hand, players: Player[], betting: BettingState) {
  let market = await tx.predictionMarket.findUnique({ where: { handId: hand.id } })
  if (!market || market.status !== 'open') return market
  market = await lockMarket(tx, market.id)

  // When an action ends the hand (usually the final fold), the outcome is already
  // known. Lock the last pre-action quote instead of repricing with that knowledge.
  if (betting.phase === 'showdown') return lockMarketNow(tx, market)

  const nextRevision = market.revision + 1
  await persistQuoteRevision(tx, room, { ...hand, bettingState: betting as unknown as Prisma.JsonValue }, players, market, nextRevision)
  if (market.pricingMode !== 'fixed_odds' && betting.street === 'preflop' && betting.phase === 'reveal' && !market.lockDueAt) {
    const settings = parseRoomSettings(room.settings)
    const lockDueAt = new Date(Date.now() + settings.predictions.gracePeriodSeconds * 1000)
    market = await tx.predictionMarket.update({ where: { id: market.id }, data: { lockDueAt } })
  }
  return market
}

async function lockMarketNow(tx: Tx, market: PredictionMarket) {
  if (market.status !== 'open') return market
  const updated = await tx.predictionMarket.update({ where: { id: market.id }, data: { status: 'locked', lockedAt: new Date() } })
  await tx.auditLog.create({ data: { roomId: market.roomId, actorRole: 'system', eventType: 'prediction.market.locked', payload: { marketId: market.id, revision: market.revision } } })
  return updated
}

export async function ensurePredictionMarketLockedForReveal(tx: Tx, room: Room, hand: Hand) {
  let market = await tx.predictionMarket.findUnique({ where: { handId: hand.id } })
  if (!market || market.status === 'locked' || market.status === 'settled' || market.status === 'void') return market
  market = await lockMarket(tx, market.id)
  // New markets span all streets. Legacy tickets keep pool settlement but must
  // never delay physical play either.
  if (market.pricingMode === 'fixed_odds') return market
  return lockMarketNow(tx, market)
}

export async function placePredictionBet(_input: {
  roomCode: string; marketId: string; accountToken: string; memberId: string; candidatePlayerId: string; stake: number; clientRequestId: string; expectedMarketRevision: number
}): Promise<{ bet: PredictionBetView; state: PredictionViewerState }> {
  throw createError({ statusCode: 410, statusMessage: 'Денежные прогнозы заменены тремя жетонами. Обновите страницу' })
}

export async function issuePredictionGrantForEliminated(tx: Tx, room: Room, player: Player) {
  const settings = parseRoomSettings(room.settings)
  if (!settings.predictions.enabled || !player.memberId || !player.userId || player.stack > 0) return false
  await tx.$queryRaw`SELECT id FROM "room_members" WHERE id = CAST(${player.memberId} AS uuid) FOR UPDATE`
  const member = await tx.roomMember.findUnique({ where: { id: player.memberId } })
  if (!member || member.predictionGrantIssuedAt) {
    if (member && member.state !== 'predicting') await tx.roomMember.update({ where: { id: member.id }, data: { state: 'predicting', eliminatedAt: member.eliminatedAt || new Date() } })
    return false
  }
  // Tokens are a per-hand allowance, not money or a prediction-wallet grant.
  await tx.roomMember.update({ where: { id: member.id }, data: { state: 'predicting', eliminatedAt: new Date(), updatedAt: new Date() } })
  return true
}

export async function settlePredictionMarket(tx: Tx, room: Room, hand: Hand, mainPotWinnerIds: string[]) {
  let market = await tx.predictionMarket.findUnique({ where: { handId: hand.id } })
  if (!market || ['settled', 'void'].includes(market.status)) return market
  market = await lockMarket(tx, market.id)
  if (!mainPotWinnerIds.length) return voidPredictionMarket(tx, market, 'no_main_pot_winner')
  const bets = await tx.predictionBet.findMany({ where: { marketId: market.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  await ensureAchievementDefinitions(tx)
  const totalReal = bets.reduce((sum, bet) => sum + bet.stake, 0n)
  const winnerSet = new Set(mainPotWinnerIds)
  const quotes = await tx.predictionQuote.findMany({ where: { marketId: market.id, revision: market.revision, candidatePlayerId: { in: mainPotWinnerIds } } })
  if (market.pricingMode !== 'fixed_odds' && quotes.length !== mainPotWinnerIds.length) return voidPredictionMarket(tx, market, 'winner_not_quoted')
  const winning = bets.filter(bet => winnerSet.has(bet.candidatePlayerId))
  const totalPool = toChipNumber(market.liquidity + totalReal)
  const settled = market.pricingMode === 'fixed_odds' ? settleFixedPredictions(market.liquidity + totalReal, mainPotWinnerIds, bets.map(bet => ({
    id: bet.id, candidatePlayerId: bet.candidatePlayerId, stake: bet.stake, potentialPayout: bet.potentialPayout
  }))) : settlePredictionPool({
    totalPool,
    winnerVirtualStake: quotes.reduce((sum, quote) => sum + toChipNumber(quote.virtualStake), 0),
    winningBets: winning.map(bet => ({ id: bet.id, stake: toChipNumber(bet.stake), createdAt: bet.createdAt.getTime() }))
  })
  let distributed = 0n
  for (const bet of bets) {
    const payout = BigInt(settled.payouts.get(bet.id) || 0)
    const isWinner = winnerSet.has(bet.candidatePlayerId)
    if (isWinner && payout > 0n) {
      const wallet = await lockPredictionWallet(tx, bet.memberId)
      if (!wallet) throw createError({ statusCode: 500, statusMessage: 'Не найден прогнозный кошелёк победителя' })
      const updated = await tx.predictionWallet.update({ where: { id: wallet.id }, data: { balance: { increment: payout }, version: { increment: 1 }, updatedAt: new Date() } })
      const transferId = randomUUID()
      await recordRoomLedger(tx, {
        roomId: room.id, memberId: bet.memberId, marketId: market.id, transferId, accountType: 'market_pool', entryType: 'PREDICTION_PAYOUT_DEBIT',
        amount: -payout, idempotencyKey: `prediction-payout-debit:${bet.id}`
      })
      await recordRoomLedger(tx, {
        roomId: room.id, memberId: bet.memberId, marketId: market.id, transferId, accountType: 'prediction_wallet', entryType: 'PREDICTION_PAYOUT_CREDIT',
        amount: payout, balanceAfter: updated.balance, idempotencyKey: `prediction-payout:${bet.id}`
      })
    }
    distributed += payout
    const netProfit = payout - bet.stake
    const member = await tx.roomMember.findUnique({ where: { id: bet.memberId }, include: { accounts: { where: { isActive: true }, take: 1 } } })
    let ratingDelta: number | null = null
    if (member?.accounts[0]?.userId) {
      const previousLosses = await tx.predictionBet.count({ where: { memberId: bet.memberId, status: 'lost', settledAt: { not: null } } })
      const rating = calculatePredictionRatingDelta({ won: isWinner, splitWinnerCount: mainPotWinnerIds.length, riskPercent: bet.riskPercent, consecutiveLosses: previousLosses })
      const userId = member.accounts[0].userId
      const event = await tx.predictionRatingEvent.create({ data: { userId, betId: bet.id, delta: rating.delta, reason: rating.reason } })
      const account = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { predictionRating: true } })
      await tx.user.update({
        where: { id: userId },
        data: {
          predictionRating: applyRatingChange(account.predictionRating, event.delta),
          predictionCount: { increment: 1 },
          predictionWins: { increment: isWinner ? 1 : 0 },
          predictionSplitWins: { increment: isWinner && mainPotWinnerIds.length > 1 ? 1 : 0 }
        }
      })
      ratingDelta = event.delta
    }
    await tx.predictionBet.update({ where: { id: bet.id }, data: { status: isWinner ? 'won' : 'lost', grossPayout: payout, netProfit, ratingDelta, ratingAppliedAt: ratingDelta === null ? null : new Date(), settledAt: new Date() } })
    if (member?.accounts[0]?.userId && isWinner) {
      const latestPredictions = await tx.predictionBet.findMany({
        where: { member: { accounts: { some: { userId: member.accounts[0].userId } } }, status: { in: ['won', 'lost'] } },
        select: { status: true },
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
        take: 3
      })
      if (latestPredictions.length === 3 && latestPredictions.every(item => item.status === 'won')) {
        await unlockAchievement(tx, member.accounts[0].userId, 'prediction_hat_trick')
      }
    }
  }
  const treasuryReturn = BigInt(settled.treasuryReturn)
  const treasury = await tx.roomTreasury.findUniqueOrThrow({ where: { roomId: room.id } })
  await tx.$queryRaw`SELECT id FROM "room_treasuries" WHERE id = CAST(${treasury.id} AS uuid) FOR UPDATE`
  const updatedTreasury = await tx.roomTreasury.update({ where: { id: treasury.id }, data: { balance: { increment: treasuryReturn }, version: { increment: 1 }, updatedAt: new Date() } })
  if (treasuryReturn > 0n) {
    const transferId = randomUUID()
    await recordRoomLedger(tx, {
      roomId: room.id, marketId: market.id, transferId, accountType: 'market_pool', entryType: 'MARKET_SETTLEMENT_DEBIT',
      amount: -treasuryReturn, idempotencyKey: `market-settlement-debit:${market.id}`
    })
    await recordRoomLedger(tx, {
      roomId: room.id, marketId: market.id, transferId, accountType: 'treasury', entryType: 'MARKET_SETTLEMENT_RETURN',
      amount: treasuryReturn, balanceAfter: updatedTreasury.balance, idempotencyKey: `market-settlement-treasury:${market.id}`
    })
  }
  if (distributed + treasuryReturn !== market.liquidity + totalReal) throw createError({ statusCode: 500, statusMessage: 'Нарушен инвариант распределения рынка прогнозов' })
  market = await tx.predictionMarket.update({ where: { id: market.id }, data: { status: 'settled', settledAt: new Date(), resolutionPlayerId: mainPotWinnerIds.length === 1 ? mainPotWinnerIds[0] : null, lockedAt: market.lockedAt || new Date() } })
  await tx.auditLog.create({ data: { roomId: room.id, actorRole: 'system', eventType: 'prediction.market.settled', payload: { marketId: market.id, winnerIds: mainPotWinnerIds, splitWinnerCount: mainPotWinnerIds.length, totalPool, treasuryReturn: Number(treasuryReturn) } } })
  return market
}

export async function voidPredictionMarket(tx: Tx, market: PredictionMarket, reason: string) {
  if (market.status === 'void' || market.status === 'settled') return market
  const bets = await tx.predictionBet.findMany({ where: { marketId: market.id, status: 'open' } })
  for (const bet of bets) {
    const wallet = await lockPredictionWallet(tx, bet.memberId)
    if (!wallet) continue
    const updated = await tx.predictionWallet.update({ where: { id: wallet.id }, data: { balance: { increment: bet.stake }, version: { increment: 1 }, updatedAt: new Date() } })
    await tx.predictionBet.update({ where: { id: bet.id }, data: { status: 'refunded', grossPayout: bet.stake, netProfit: 0, settledAt: new Date() } })
    const transferId = randomUUID()
    await recordRoomLedger(tx, {
      roomId: market.roomId, memberId: bet.memberId, marketId: market.id, transferId, accountType: 'market_pool', entryType: 'PREDICTION_REFUND_DEBIT',
      amount: -bet.stake, idempotencyKey: `prediction-refund-debit:${bet.id}`, metadata: { reason }
    })
    await recordRoomLedger(tx, {
      roomId: market.roomId, memberId: bet.memberId, marketId: market.id, transferId, accountType: 'prediction_wallet', entryType: 'PREDICTION_REFUND_CREDIT',
      amount: bet.stake, balanceAfter: updated.balance, idempotencyKey: `prediction-refund:${bet.id}`, metadata: { reason }
    })
  }
  const treasury = await tx.roomTreasury.findUnique({ where: { roomId: market.roomId } })
  if (treasury && market.liquidity > 0n) {
    await tx.$queryRaw`SELECT id FROM "room_treasuries" WHERE id = CAST(${treasury.id} AS uuid) FOR UPDATE`
    const updated = await tx.roomTreasury.update({ where: { id: treasury.id }, data: { balance: { increment: market.liquidity }, version: { increment: 1 }, updatedAt: new Date() } })
    const transferId = randomUUID()
    await recordRoomLedger(tx, {
      roomId: market.roomId, marketId: market.id, transferId, accountType: 'market_pool', entryType: 'MARKET_VOID_DEBIT',
      amount: -market.liquidity, idempotencyKey: `market-void-debit:${market.id}`, metadata: { reason }
    })
    await recordRoomLedger(tx, {
      roomId: market.roomId, marketId: market.id, transferId, accountType: 'treasury', entryType: 'MARKET_VOID_RETURN',
      amount: market.liquidity, balanceAfter: updated.balance, idempotencyKey: `market-void-treasury:${market.id}`, metadata: { reason }
    })
  }
  const updated = await tx.predictionMarket.update({ where: { id: market.id }, data: { status: 'void', voidReason: reason, settledAt: new Date(), lockedAt: market.lockedAt || new Date() } })
  await tx.auditLog.create({ data: { roomId: market.roomId, actorRole: 'system', eventType: 'prediction.market.voided', payload: { marketId: market.id, reason } } })
  return updated
}

export async function voidPredictionMarketByDealer(input: {
  roomCode: string
  marketId: string
  dealerSecret: string
  reason: string
}) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    if (!verifySecret(input.dealerSecret, room.dealerSecretHash)) throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })

    const found = await tx.predictionMarket.findFirst({ where: { id: input.marketId, roomId: room.id } })
    if (!found) throw createError({ statusCode: 404, statusMessage: 'Рынок прогнозов не найден' })
    const market = await lockMarket(tx, found.id)
    if (market.status === 'settled' || market.status === 'void') {
      throw createError({ statusCode: 409, statusMessage: 'Рынок уже рассчитан' })
    }

    const reason = `dealer:${input.reason.trim()}`
    await voidPredictionMarket(tx, market, reason)
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 }, updatedAt: new Date() } })
    await tx.auditLog.create({
      data: {
        roomId: room.id,
        actorParticipantId: room.dealerId,
        actorRole: 'dealer',
        eventType: 'prediction.market.voided_by_dealer',
        payload: { marketId: market.id, reason: input.reason.trim() }
      }
    })
  })
}

export async function updateBehaviorStatsForHand(tx: Tx, roomId: string, handId: string, mainWinnerIds: string[], players: Player[]) {
  const actions = await tx.playerAction.findMany({ where: { handId, status: { in: ['applied', 'approved'] } } })
  const actionsByPlayer = new Map<string, typeof actions>()
  for (const action of actions) actionsByPlayer.set(action.playerId, [...(actionsByPlayer.get(action.playerId) || []), action])
  for (const player of players) {
    if (!player.memberId || ['waiting', 'out'].includes(player.status)) continue
    const items = actionsByPlayer.get(player.id) || []
    const timed = items.filter(item => item.decisionTimeMs && item.decisionTimeMs > 0)
    const existing = await tx.playerBehaviorStat.findUnique({ where: { memberId: player.memberId } })
    const oldTimedWeight = existing?.sampleSize || 0
    const decisionAverage = timed.length
      ? Math.round(((existing?.averageDecisionMs || 0) * oldTimedWeight + timed.reduce((sum, item) => sum + (item.decisionTimeMs || 0), 0)) / (oldTimedWeight + timed.length))
      : existing?.averageDecisionMs || 0
    await tx.playerBehaviorStat.upsert({
      where: { memberId: player.memberId },
      create: {
        roomId, memberId: player.memberId, sampleSize: 1, opportunities: items.length,
        bets: items.filter(item => item.type === 'bet').length, raises: items.filter(item => item.type === 'raise').length,
        folds: items.filter(item => item.type === 'fold').length, allIns: items.filter(item => item.type === 'all-in').length,
        showdowns: ['active', 'checked', 'all-in', 'winner'].includes(player.status) ? 1 : 0,
        mainPotWins: mainWinnerIds.includes(player.id) ? 1 : 0, averageDecisionMs: decisionAverage
      },
      update: {
        sampleSize: { increment: 1 }, opportunities: { increment: items.length },
        bets: { increment: items.filter(item => item.type === 'bet').length }, raises: { increment: items.filter(item => item.type === 'raise').length },
        folds: { increment: items.filter(item => item.type === 'fold').length }, allIns: { increment: items.filter(item => item.type === 'all-in').length },
        showdowns: { increment: ['active', 'checked', 'all-in', 'winner'].includes(player.status) ? 1 : 0 },
        mainPotWins: { increment: mainWinnerIds.includes(player.id) ? 1 : 0 }, averageDecisionMs: decisionAverage, updatedAt: new Date()
      }
    })
  }
}

function mapBet(bet: PredictionBet & { candidate?: { name: string }; member?: { displayName: string } }): PredictionBetView {
  return {
    id: bet.id, marketId: bet.marketId, candidatePlayerId: bet.candidatePlayerId, candidateName: bet.candidate?.name || 'Игрок', memberName: bet.member?.displayName,
    stake: toChipNumber(bet.stake), status: bet.status as PredictionBetView['status'], grossPayout: toChipNumber(bet.grossPayout),
    acceptedOdds: bet.acceptedOddsHundredths === null ? null : bet.acceptedOddsHundredths / 100,
    potentialPayout: bet.potentialPayout === null ? null : toChipNumber(bet.potentialPayout), placedStreet: bet.placedStreet as PredictionBetView['placedStreet'],
    netProfit: toChipNumber(bet.netProfit), riskPercent: bet.riskPercent, ratingDelta: bet.ratingDelta, quoteRevision: bet.quoteRevision, createdAt: bet.createdAt.toISOString(), settledAt: bet.settledAt?.toISOString()
  }
}

async function mapMarket(tx: Tx, market: PredictionMarket | null, room: Room): Promise<PredictionMarketView | null> {
  if (!market) return null
  const [hand, quotes, realPool] = await Promise.all([
    tx.hand.findUniqueOrThrow({ where: { id: market.handId } }),
    tx.predictionQuote.findMany({ where: { marketId: market.id, revision: market.revision }, include: { candidate: true }, orderBy: { candidate: { seat: 'asc' } } }),
    tx.predictionBet.aggregate({ where: { marketId: market.id }, _sum: { stake: true } })
  ])
  return {
    id: market.id, handId: market.handId, handNumber: hand.handNumber, status: market.status as PredictionMarketView['status'], revision: market.revision,
    pricingMode: market.pricingMode as PredictionMarketView['pricingMode'],
    street: (hand.bettingState as unknown as BettingState)?.street || 'preflop',
    acceptingBets: market.status === 'open' && hand.status === 'active' && (hand.bettingState as unknown as BettingState)?.phase !== 'showdown'
      && room.status === 'active' && parseRoomSettings(room.settings).predictions.enabled
      && (!market.lockDueAt || market.lockDueAt.getTime() > Date.now()),
    question: 'Кто единолично выиграет основной банк?', totalPool: toChipNumber(market.liquidity + (realPool._sum.stake || 0n)),
    openedAt: market.openedAt?.toISOString(), lockDueAt: market.lockDueAt?.toISOString(), lockedAt: market.lockedAt?.toISOString(), settledAt: market.settledAt?.toISOString(), voidReason: market.voidReason || undefined,
    quotes: quotes.map(quote => ({
      playerId: quote.candidatePlayerId, playerName: quote.candidate.name, seat: quote.candidate.seat,
      modelScore: quote.modelProbability, odds: quote.odds, realStake: toChipNumber(quote.realStake), virtualStake: toChipNumber(quote.virtualStake),
      reasonCodes: quote.reasonCodes as unknown as string[], available: quote.odds > 0
    }))
  }
}

function mapReentry(request: { id: string; memberId: string; playerId: string; amount: bigint; status: string; createdAt: Date; reviewedAt: Date | null; member: { displayName: string } }): ReentryRequestView {
  return { id: request.id, memberId: request.memberId, playerId: request.playerId, memberName: request.member.displayName, amount: toChipNumber(request.amount), status: request.status as ReentryRequestView['status'], createdAt: request.createdAt.toISOString(), reviewedAt: request.reviewedAt?.toISOString() }
}

async function applyApprovedReentry(
  tx: Tx,
  room: Room,
  request: ReentryRequest & { member: RoomMember }
) {
  const settings = parseRoomSettings(room.settings)
  if (request.member.reentryCount >= settings.predictions.maxReentriesPerMember) {
    throw createError({ statusCode: 409, statusMessage: 'Лимит возвращений исчерпан' })
  }

  const wallet = await lockPredictionWallet(tx, request.memberId)
  if (!wallet || wallet.balance - wallet.grantRemaining < request.amount) {
    throw createError({ statusCode: 409, statusMessage: 'Прибыль участника уже недостаточна для возврата' })
  }
  const player = await tx.player.findUnique({ where: { id: request.playerId } })
  if (!player || player.stack > 0 || !player.participantId) {
    throw createError({ statusCode: 409, statusMessage: 'Место игрока уже изменилось' })
  }

  const updatedWallet = await tx.predictionWallet.update({
    where: { id: wallet.id },
    data: { balance: { decrement: request.amount }, version: { increment: 1 }, updatedAt: new Date() }
  })
  await tx.player.update({
    where: { id: player.id },
    data: { stack: toChipNumber(request.amount), status: 'waiting', currentBet: 0, totalCommitted: 0, updatedAt: new Date() }
  })
  await tx.roomMember.update({
    where: { id: request.memberId },
    data: { state: 'playing', reentryCount: { increment: 1 }, updatedAt: new Date() }
  })
  const updatedRequest = await tx.reentryRequest.update({
    where: { id: request.id },
    data: { status: 'approved', reviewedAt: new Date(), reviewedByParticipantId: room.dealerId },
    include: { member: true }
  })
  const transferId = randomUUID()
  await tx.buyIn.create({
    data: {
      roomId: room.id,
      memberId: request.memberId,
      playerId: player.id,
      amount: request.amount,
      kind: 'prediction_reentry',
      transferId,
      clientRequestId: request.clientRequestId
    }
  })
  await recordRoomLedger(tx, {
    roomId: room.id, memberId: request.memberId, transferId, accountType: 'prediction_wallet', entryType: 'REENTRY_DEBIT',
    amount: -request.amount, balanceAfter: updatedWallet.balance, idempotencyKey: `reentry-debit:${request.id}`
  })
  await recordRoomLedger(tx, {
    roomId: room.id, memberId: request.memberId, transferId, accountType: 'table_stack', entryType: 'REENTRY_CREDIT',
    amount: request.amount, balanceAfter: request.amount, idempotencyKey: `reentry-credit:${request.id}`, metadata: { playerId: player.id }
  })
  return updatedRequest
}

export async function getPredictionViewerState(roomCode: string, token: string): Promise<PredictionViewerState> {
  return prisma.$transaction(async tx => {
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    const auth = await verifyUserAuthToken(token, tx)
    if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
    const participant = await tx.roomParticipant.findFirst({ where: { roomId: room.id, userId: auth.userId, isConnected: true }, orderBy: { joinedAt: 'desc' } })
    if (!participant?.memberId) throw createError({ statusCode: 403, statusMessage: 'Прогнозы доступны только участнику с аккаунтом' })
    const member = await tx.roomMember.findUnique({ where: { id: participant.memberId }, include: { predictionWallet: true } })
    if (!member) throw createError({ statusCode: 403, statusMessage: 'Участник вечера не найден' })
    const settings = parseRoomSettings(room.settings)
    const market = await tx.predictionMarket.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' } })
    const ownBets = await tx.predictionBet.findMany({ where: { memberId: member.id }, include: { candidate: true }, orderBy: { createdAt: 'desc' }, take: 20 })
    const pending = await tx.reentryRequest.findFirst({ where: { memberId: member.id, status: 'pending' }, include: { member: true } })
    const balance = member.predictionWallet ? toChipNumber(member.predictionWallet.balance) : 0
    const grantRemaining = member.predictionWallet ? toChipNumber(member.predictionWallet.grantRemaining) : 0
    const eligible = settings.predictions.enabled && ['predicting', 'pending_reentry'].includes(member.state)
    return {
      eligible,
      roomId: room.id, roomRevision: room.revision,
      reason: !settings.predictions.enabled ? 'Прогнозы отключены дилером' : !eligible ? 'Прогнозы откроются после вылета из игры' : undefined,
      memberId: member.id, memberState: member.state as PredictionViewerState['memberState'], balance, grantRemaining,
      availableProfit: Math.max(0, balance - grantRemaining), minStake: settings.predictions.minStake,
      maxStake: Math.min(settings.predictions.maxStake, Math.floor(toChipNumber(member.predictionGrant) * settings.predictions.maxStakePercentOfGrant / 100), balance),
      comebackMinBuyIn: settings.predictions.comebackMinBuyIn, comebackMaxBuyIn: settings.predictions.comebackMaxBuyIn,
      reentryCount: member.reentryCount, maxReentries: settings.predictions.maxReentriesPerMember,
      currentMarket: member.state === 'predicting' ? await mapMarket(tx, market, room) : null,
      currentBet: ownBets.find(bet => bet.marketId === market?.id) ? mapBet(ownBets.find(bet => bet.marketId === market?.id)!) : null,
      recentBets: ownBets.map(mapBet), pendingReentry: pending ? mapReentry(pending) : null
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function getDealerPredictionState(roomCode: string, dealerSecret: string): Promise<DealerPredictionState> {
  return prisma.$transaction(async tx => {
    const room = await tx.room.findUnique({ where: { code: roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    if (!verifySecret(dealerSecret, room.dealerSecretHash)) throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
    const [treasury, market, members, reentries] = await Promise.all([
      tx.roomTreasury.findUnique({ where: { roomId: room.id } }),
      tx.predictionMarket.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' } }),
      tx.roomMember.findMany({ where: { roomId: room.id }, include: { accounts: { where: { isActive: true } }, players: { orderBy: { createdAt: 'desc' }, take: 1 }, participants: { where: { isConnected: true } } }, orderBy: { createdAt: 'asc' } }),
      tx.reentryRequest.findMany({ where: { roomId: room.id, status: 'pending' }, include: { member: true }, orderBy: { createdAt: 'asc' } })
    ])
    const bets = market ? await tx.predictionBet.findMany({ where: { marketId: market.id }, include: { candidate: true, member: true }, orderBy: { createdAt: 'asc' } }) : []
    const mappedMembers: RoomMemberSummary[] = members.map(member => ({
      id: member.id, displayName: member.displayName, state: member.state as RoomMemberSummary['state'], initialBuyIn: member.initialBuyIn ? toChipNumber(member.initialBuyIn) : null,
      requestedBuyIn: member.requestedBuyIn ? toChipNumber(member.requestedBuyIn) : null, predictionGrant: toChipNumber(member.predictionGrant),
      eliminatedAt: member.eliminatedAt?.toISOString(), reentryCount: member.reentryCount, playerId: member.players[0]?.id,
      userId: member.accounts[0]?.userId, isConnected: member.participants.length > 0
    }))
    return {
      roomId: room.id, roomRevision: room.revision,
      treasuryBalance: treasury ? toChipNumber(treasury.balance) : 0, currentMarket: await mapMarket(tx, market, room), bets: bets.map(mapBet), members: mappedMembers,
      entryRequests: mappedMembers.filter(member => member.state === 'pending'), reentryRequests: reentries.map(mapReentry)
    }
  }, { isolationLevel: 'RepeatableRead' })
}

export async function requestReentry(input: { roomCode: string; accountToken: string; memberId: string; amount: number; clientRequestId: string }) {
  const auth = await verifyUserAuthToken(input.accountToken)
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт повторно' })
  const request = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    const duplicate = await tx.reentryRequest.findFirst({ where: { roomId: room.id, memberId: input.memberId, clientRequestId: input.clientRequestId }, include: { member: true } })
    if (duplicate) return duplicate
    const activeHand = await tx.hand.findFirst({ where: { roomId: room.id, status: { in: ['active', 'showdown'] } } })
    if (activeHand) throw createError({ statusCode: 409, statusMessage: 'Вернуться можно только между раздачами' })
    await tx.$queryRaw`SELECT id FROM "room_members" WHERE id = CAST(${input.memberId} AS uuid) FOR UPDATE`
    const member = await tx.roomMember.findFirst({ where: { id: input.memberId, roomId: room.id, state: 'predicting', accounts: { some: { userId: auth.userId, isActive: true } } } })
    if (!member) throw createError({ statusCode: 403, statusMessage: 'Возврат для этого участника недоступен' })
    const settings = parseRoomSettings(room.settings)
    if (!settings.predictions.enabled) throw createError({ statusCode: 409, statusMessage: 'Прогнозы отключены дилером' })
    if (member.reentryCount >= settings.predictions.maxReentriesPerMember) throw createError({ statusCode: 409, statusMessage: 'Лимит возвращений исчерпан' })
    const wallet = await lockPredictionWallet(tx, member.id)
    if (!wallet) throw createError({ statusCode: 409, statusMessage: 'Зрительский баланс не найден' })
    if (await tx.predictionBet.findFirst({ where: { memberId: member.id, status: 'open' } })) throw createError({ statusCode: 409, statusMessage: 'Сначала дождитесь расчёта текущего прогноза' })
    const profit = wallet.balance - wallet.grantRemaining
    if (input.amount < settings.predictions.comebackMinBuyIn || input.amount > settings.predictions.comebackMaxBuyIn || BigInt(input.amount) > profit) {
      throw createError({ statusCode: 409, statusMessage: `Для возвращения доступно ${Math.max(0, toChipNumber(profit))} фишек` })
    }
    const player = await tx.player.findFirst({ where: { roomId: room.id, memberId: member.id, participantId: { not: null } }, orderBy: { createdAt: 'desc' } })
    if (!player || player.stack > 0) throw createError({ statusCode: 409, statusMessage: 'Место для возврата не найдено' })
    let created = await tx.reentryRequest.create({ data: { roomId: room.id, memberId: member.id, playerId: player.id, amount: BigInt(input.amount), status: 'pending', clientRequestId: input.clientRequestId }, include: { member: true } })
    if (settings.predictions.requireDealerApprovalForReentry) {
      await tx.roomMember.update({ where: { id: member.id }, data: { state: 'pending_reentry', updatedAt: new Date() } })
    } else {
      created = await applyApprovedReentry(tx, room, created)
      await tx.auditLog.create({
        data: { roomId: room.id, actorRole: 'system', eventType: 'reentry.auto_approved', payload: { requestId: created.id, memberId: member.id, amount: input.amount } }
      })
    }
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
    return created
  })
  return { request: mapReentry(request), state: await getPredictionViewerState(input.roomCode, input.accountToken) }
}

export async function resolveReentry(input: { roomCode: string; dealerSecret: string; requestId: string; decision: 'approve' | 'reject' }) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "rooms" WHERE code = ${input.roomCode} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code: input.roomCode } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    if (!verifySecret(input.dealerSecret, room.dealerSecretHash)) throw createError({ statusCode: 403, statusMessage: 'Неверный dealerSecret' })
    const request = await tx.reentryRequest.findFirst({ where: { id: input.requestId, roomId: room.id }, include: { member: true } })
    if (!request || request.status !== 'pending') throw createError({ statusCode: 409, statusMessage: 'Запрос уже обработан' })
    await tx.$queryRaw`SELECT id FROM "room_members" WHERE id = CAST(${request.memberId} AS uuid) FOR UPDATE`
    if (input.decision === 'reject') {
      await tx.reentryRequest.update({ where: { id: request.id }, data: { status: 'rejected', reviewedAt: new Date(), reviewedByParticipantId: room.dealerId } })
      await tx.roomMember.update({ where: { id: request.memberId }, data: { state: 'predicting', updatedAt: new Date() } })
    } else {
      const activeHand = await tx.hand.findFirst({ where: { roomId: room.id, status: { in: ['active', 'showdown'] } } })
      if (activeHand) throw createError({ statusCode: 409, statusMessage: 'Одобрить возврат можно только между раздачами' })
      await applyApprovedReentry(tx, room, request)
    }
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
    await tx.auditLog.create({ data: { roomId: room.id, actorParticipantId: room.dealerId, actorRole: 'dealer', eventType: `reentry.${input.decision === 'approve' ? 'approved' : 'rejected'}`, payload: { requestId: request.id, memberId: request.memberId, amount: Number(request.amount) } } })
  })
}
