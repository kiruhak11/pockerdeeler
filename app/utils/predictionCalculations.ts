import type { Street } from './bettingRounds'

export interface BehaviorStatsInput {
  sampleSize: number
  opportunities: number
  bets: number
  raises: number
  folds: number
  allIns: number
  showdowns: number
  mainPotWins: number
  averageDecisionMs: number
}

export interface PredictionCandidateInput {
  playerId: string
  playerName: string
  seat: number
  stack: number
  currentBet: number
  totalCommitted: number
  status: string
  actionTypes: string[]
  lastDecisionMs?: number
  stats?: BehaviorStatsInput
}

export interface ModelCandidateScore {
  playerId: string
  probability: number
  reasonCodes: string[]
  available: boolean
}

export interface PredictionQuoteInput extends ModelCandidateScore {
  playerName: string
  seat: number
  realStake: number
}

export interface PredictionQuoteResult extends PredictionQuoteInput {
  virtualStake: number
  odds: number
}

export interface WinningPredictionInput {
  id: string
  stake: number
  createdAt: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function shrink(value: number, prior: number, samples: number, strength = 8): number {
  const safeSamples = Math.max(0, samples)
  return (value * safeSamples + prior * strength) / (safeSamples + strength)
}

/** Integer allocation with deterministic largest-remainder rounding. */
export function allocateIntegerByWeight(total: number, entries: { id: string; weight: number; order?: number }[]): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Некорректный распределяемый фонд')
  const positive = entries.filter(entry => Number.isFinite(entry.weight) && entry.weight > 0)
  const weightTotal = positive.reduce((sum, entry) => sum + entry.weight, 0)
  const result = new Map(entries.map(entry => [entry.id, 0]))
  if (!positive.length || total === 0 || weightTotal <= 0) return result

  const parts = positive.map(entry => {
    const exact = total * entry.weight / weightTotal
    return { ...entry, amount: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let left = total - parts.reduce((sum, part) => sum + part.amount, 0)
  parts.sort((a, b) => b.remainder - a.remainder || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
  for (let index = 0; left > 0; index = (index + 1) % parts.length, left -= 1) parts[index]!.amount += 1
  for (const part of parts) result.set(part.id, part.amount)
  return result
}

/**
 * Produces a deliberately conservative game score from public information only.
 * The historical component is shrunk toward room averages, while current actions
 * can move the score only within the configured behaviorImpact envelope.
 */
export function calculateBehaviorScores(
  candidates: PredictionCandidateInput[],
  options: { behaviorImpact: number; bigBlind: number; includeDecisionTime: boolean }
): ModelCandidateScore[] {
  const contenders = candidates.filter(candidate => !['folded', 'out', 'waiting'].includes(candidate.status))
  if (!contenders.length) return candidates.map(candidate => ({ playerId: candidate.playerId, probability: 0, reasonCodes: ['not_in_hand'], available: false }))

  const impact = clamp(options.behaviorImpact, 0, 0.35)
  const raw = contenders.map(candidate => {
    const stats = candidate.stats
    const opportunities = Math.max(0, stats?.opportunities ?? 0)
    const aggression = shrink(opportunities ? ((stats?.bets ?? 0) + (stats?.raises ?? 0) + (stats?.allIns ?? 0)) / opportunities : 0.35, 0.35, opportunities)
    const survival = shrink(opportunities ? 1 - (stats?.folds ?? 0) / opportunities : 0.65, 0.65, opportunities)
    const showdown = shrink((stats?.showdowns ?? 0) ? (stats?.mainPotWins ?? 0) / Math.max(1, stats?.showdowns ?? 0) : 0.5, 0.5, stats?.showdowns ?? 0)
    const stackBb = (candidate.stack + candidate.currentBet) / Math.max(1, options.bigBlind)
    const stackSignal = clamp(Math.log2(Math.max(1, stackBb)) / 12, 0, 1)
    const actions = candidate.actionTypes
    const aggressiveNow = actions.filter(type => ['bet', 'raise', 'all-in'].includes(type)).length
    const passiveNow = actions.filter(type => ['check', 'call'].includes(type)).length
    const reasons: string[] = []
    if (aggressiveNow) reasons.push(actions.includes('all-in') ? 'all_in_now' : 'aggressive_now')
    if (passiveNow && !aggressiveNow) reasons.push('careful_line')
    if (aggression > 0.48) reasons.push('historically_aggressive')
    if (survival > 0.72) reasons.push('often_reaches_showdown')
    if ((stats?.sampleSize ?? 0) < 5) reasons.push('limited_history')

    let timingSignal = 0
    if (options.includeDecisionTime && candidate.lastDecisionMs && stats?.averageDecisionMs) {
      timingSignal = clamp((stats.averageDecisionMs - candidate.lastDecisionMs) / Math.max(1000, stats.averageDecisionMs), -1, 1)
      if (timingSignal > 0.35) reasons.push('quick_decision')
      if (timingSignal < -0.35) reasons.push('long_decision')
    }

    const historical = (aggression - 0.35) * 0.8 + (survival - 0.65) * 0.7 + (showdown - 0.5) * 0.8
    const current = aggressiveNow * 0.22 - passiveNow * 0.03 + timingSignal * 0.08 + (stackSignal - 0.5) * 0.15
    return { candidate, reasons, strength: Math.exp((historical + current) * impact * 3) }
  })

  const total = raw.reduce((sum, item) => sum + item.strength, 0)
  const byId = new Map(raw.map(item => [item.candidate.playerId, {
    playerId: item.candidate.playerId,
    probability: item.strength / total,
    reasonCodes: item.reasons,
    available: true
  }]))

  return candidates.map(candidate => byId.get(candidate.playerId) ?? {
    playerId: candidate.playerId,
    probability: 0,
    reasonCodes: ['not_in_hand'],
    available: false
  })
}

export function calculatePredictionQuotes(inputs: PredictionQuoteInput[], liquidity: number): PredictionQuoteResult[] {
  const active = inputs.filter(input => input.available && input.probability > 0)
  const probabilityTotal = active.reduce((sum, input) => sum + input.probability, 0)
  const virtual = allocateIntegerByWeight(liquidity, active.map(input => ({ id: input.playerId, weight: input.probability / probabilityTotal, order: input.seat })))
  const realPool = inputs.reduce((sum, input) => sum + input.realStake, 0)
  const totalPool = realPool + liquidity

  return inputs.map(input => {
    const virtualStake = virtual.get(input.playerId) ?? 0
    const denominator = input.realStake + virtualStake
    return {
      ...input,
      virtualStake,
      odds: input.available && denominator > 0 ? Math.max(1, totalPool / denominator) : 0
    }
  })
}

export function settlePredictionPool(input: {
  totalPool: number
  winnerVirtualStake: number
  winningBets: WinningPredictionInput[]
}): { payouts: Map<string, number>; treasuryReturn: number } {
  const virtualId = '__virtual__'
  const allocation = allocateIntegerByWeight(input.totalPool, [
    { id: virtualId, weight: input.winnerVirtualStake, order: -1 },
    ...input.winningBets.map((bet, index) => ({ id: bet.id, weight: bet.stake, order: bet.createdAt || index }))
  ])
  const payouts = new Map<string, number>()
  for (const bet of input.winningBets) payouts.set(bet.id, allocation.get(bet.id) ?? 0)
  return { payouts, treasuryReturn: allocation.get(virtualId) ?? input.totalPool }
}

/** Public-behavior game pricing, not card equity. Later information reduces the
 * early-street premium; the fixed quote uses integer hundredths, never floats in payouts. */
export function calculateFixedPredictionQuotes(inputs: PredictionQuoteInput[], liquidity: number, street: Street): PredictionQuoteResult[] {
  const premium = { preflop: 1, flop: 0.95, turn: 0.9, river: 0.85 }[street]
  return calculatePredictionQuotes(inputs, liquidity).map(quote => ({
    ...quote,
    odds: quote.available ? Math.floor(clamp(1 + (quote.odds - 1) * premium, 1.01, 25) * 100 + 1e-8) / 100 : 0
  }))
}

export function fixedPredictionPayout(stake: bigint, oddsHundredths: number): bigint {
  if (stake <= 0n || !Number.isSafeInteger(oddsHundredths) || oddsHundredths < 101 || oddsHundredths > 2500) throw new Error('Некорректный фиксированный прогноз')
  return stake * BigInt(oddsHundredths) / 100n
}

export function predictionRiskPercent(stake: number, balanceBefore: number): number {
  if (!Number.isSafeInteger(stake) || !Number.isSafeInteger(balanceBefore) || stake <= 0 || balanceBefore <= 0) return 0
  return Math.round(stake * 100 / balanceBefore)
}

export function calculatePredictionRatingDelta(input: { won: boolean; splitWinnerCount: number; riskPercent: number; consecutiveLosses: number }): { delta: number; reason: string } {
  const risk = Math.max(0, input.riskPercent)
  if (input.won) return input.splitWinnerCount > 1 ? { delta: 2, reason: 'Выигрыш при делёжке' } : risk <= 5 ? { delta: 4, reason: 'Аккуратный выигрыш' } : { delta: 2, reason: 'Выигрыш прогноза' }
  if (risk > 50) return { delta: -6 - Math.min(3, Math.max(0, input.consecutiveLosses - 1)), reason: 'Проигрыш ставки с экстремальным риском' }
  if (risk >= 20) return { delta: -4, reason: 'Проигрыш ставки с высоким риском' }
  return { delta: -2, reason: 'Проигрыш небольшой ставки' }
}

/** Only one main-pot winner is possible. Fully reserve the largest candidate's
 * liability before accepting a ticket, including stakes on losing candidates. */
export function requiredPredictionReserve(pool: bigint, tickets: { candidatePlayerId: string; potentialPayout: bigint }[]): bigint {
  const liability = new Map<string, bigint>()
  let maximum = 0n
  for (const ticket of tickets) {
    const amount = (liability.get(ticket.candidatePlayerId) || 0n) + ticket.potentialPayout
    liability.set(ticket.candidatePlayerId, amount)
    if (amount > maximum) maximum = amount
  }
  return maximum > pool ? maximum - pool : 0n
}

/**
 * Settles fixed-odds tickets when the main pot has one or more winners.
 * The accepted stake is always returned first; only the original net profit is
 * divided between the confirmed winners. This keeps split-pot predictions as
 * wins without changing the odds that were locked when the ticket was placed.
 */
export function settleFixedPredictions(pool: bigint, winnerIds: string[], tickets: { id: string; candidatePlayerId: string; stake: bigint; potentialPayout: bigint | null }[]) {
  if (!winnerIds.length) throw new Error('Нет победителей для расчета прогнозов')
  const winnerSet = new Set(winnerIds)
  const winnerCount = BigInt(winnerIds.length)
  const payouts = new Map<string, number>()
  let distributed = 0n
  for (const ticket of tickets) {
    if (ticket.potentialPayout === null) throw new Error('У фиксированного прогноза нет обещанной выплаты')
    const payout = winnerSet.has(ticket.candidatePlayerId)
      ? ticket.stake + (ticket.potentialPayout - ticket.stake) / winnerCount
      : 0n
    if (payout > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Слишком большая выплата')
    payouts.set(ticket.id, Number(payout))
    distributed += payout
  }
  if (distributed > pool) throw new Error('Недостаточно резерва для выплаты прогнозов')
  const remainder = pool - distributed
  if (remainder > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Слишком большой резерв')
  return { payouts, treasuryReturn: Number(remainder) }
}
