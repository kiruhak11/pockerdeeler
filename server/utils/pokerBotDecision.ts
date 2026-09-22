import { randomInt } from 'node:crypto'
import type { BotPlayStyle, BotSkillTier } from '../services/botIdentityService'
import { evaluateHand, type HandCategory } from './pokerHandEvaluator'
import { RANKS, SUITS, type Card } from './pokerDeck'
import type { HandStreet } from './pokerHandState'
import { BETTING_ACTION_TYPES, type BettingAction, type BettingActionType } from './pokerBetting'

/** Public context supplied to a bot. It intentionally has no deck or opponent cards. */
export type BotDecisionContext = Readonly<{
  playerId: string
  street: Extract<HandStreet, 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER'>
  holeCards: readonly Card[]
  board: readonly Card[]
  pot: number
  currentBet: number
  streetContribution: number
  toCall: number
  stack: number
  seat?: number
  dealerSeat?: number
  smallBlindSeat?: number
  bigBlindSeat?: number
  smallBlind?: number
  bigBlind: number
  /** Count of non-folded players still in the hand, including the bot. */
  activePlayers?: number
  /** Public table snapshot; no hole cards are accepted here. */
  publicPlayers?: readonly BotPublicPlayer[]
  /** Current full-raise target. Defaults to currentBet + bigBlind. */
  minRaiseTo?: number
  /** Server-derived reopening state. False prevents all-in from bypassing a closed raise right. */
  raiseReopened?: boolean
  /** Opening bet target. Defaults to bigBlind. */
  minBet?: number
  /** Explicit server-derived legal actions. Inference is only a safe fallback. */
  legalActions?: readonly BettingActionType[]
  position?: BotPosition
  actionHistory?: readonly BotPublicAction[]
}>

export type BotPosition = 'EARLY' | 'MIDDLE' | 'LATE' | 'SMALL_BLIND' | 'BIG_BLIND' | 'DEALER'

/** TAG/LAG are accepted aliases for the persisted aggressive style names. */
export type BotDecisionPlayStyle = BotPlayStyle | 'TAG' | 'LAG'
export type BotDecisionProfile = Readonly<{ skillTier: BotSkillTier; playStyle: BotDecisionPlayStyle }>

/** Public action history may contain amounts and actors, but never private cards. */
export type BotPublicAction = Readonly<{
  playerId?: string
  type: BettingActionType
  street?: BotDecisionContext['street']
  amount?: number
}>

export type BotPublicPlayer = Readonly<{
  playerId: string
  seat?: number
  stack: number
  streetContribution: number
  status: 'ACTIVE' | 'ALL_IN' | 'FOLDED' | 'OUT'
}>

export type BotRandomSource = (() => number) | Readonly<{ next: () => number }>

export type BotDecision = Readonly<BettingAction & {
  strength: number
  potOdds: number
  rationale: 'check' | 'fold' | 'call' | 'value-bet' | 'value-raise' | 'semi-bluff' | 'all-in' | 'fallback'
}>

const RANK_VALUES: Readonly<Record<(typeof RANKS)[number], number>> = Object.freeze(
  Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2])) as Record<(typeof RANKS)[number], number>
)

const VALID_STYLES: readonly BotDecisionPlayStyle[] = ['TIGHT_AGGRESSIVE', 'LOOSE_AGGRESSIVE', 'TIGHT_PASSIVE', 'LOOSE_PASSIVE', 'BALANCED', 'TAG', 'LAG']
const VALID_TIERS: readonly BotSkillTier[] = ['WEAK', 'CASUAL', 'REGULAR', 'STRONG']

const TIER_PROFILE: Readonly<Record<BotSkillTier, Readonly<{ threshold: number; aggression: number; variance: number }>>> = Object.freeze({
  WEAK: Object.freeze({ threshold: -0.08, aggression: -0.02, variance: 0.22 }),
  CASUAL: Object.freeze({ threshold: 0.01, aggression: 0.04, variance: 0.16 }),
  REGULAR: Object.freeze({ threshold: 0.07, aggression: 0.1, variance: 0.1 }),
  STRONG: Object.freeze({ threshold: 0.13, aggression: 0.15, variance: 0.05 })
})

const STYLE_PROFILE: Readonly<Record<BotPlayStyle, Readonly<{ threshold: number; aggression: number; bluff: number; callBias: number }>>> = Object.freeze({
  TIGHT_AGGRESSIVE: Object.freeze({ threshold: 0.1, aggression: 0.24, bluff: 0.04, callBias: -0.02 }),
  LOOSE_AGGRESSIVE: Object.freeze({ threshold: -0.08, aggression: 0.34, bluff: 0.14, callBias: 0.03 }),
  TIGHT_PASSIVE: Object.freeze({ threshold: 0.16, aggression: -0.12, bluff: 0.01, callBias: -0.02 }),
  LOOSE_PASSIVE: Object.freeze({ threshold: -0.1, aggression: -0.08, bluff: 0.07, callBias: 0.13 }),
  BALANCED: Object.freeze({ threshold: 0.03, aggression: 0.1, bluff: 0.06, callBias: 0 })
})

function randomValue(source: BotRandomSource): number {
  const value = typeof source === 'function' ? source() : source.next()
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.999999, Math.max(0, value))
}

/** Cryptographically backed non-deterministic source for production decisions. */
export const secureBotRandom: BotRandomSource = Object.freeze({
  next: () => randomInt(0, 1_000_000) / 1_000_000
})

/** Small deterministic source for repeatable strategy tests and simulations. */
export function createSeededBotRandom(seed: number): () => number {
  let state = (Number.isSafeInteger(seed) ? seed : 1) >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function rankValue(rank: Card['rank']): number {
  return RANK_VALUES[rank]
}

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function validCards(cards: readonly Card[]): boolean {
  const seen = new Set<string>()
  for (const card of cards) {
    if (!card || !SUITS.includes(card.suit) || !RANKS.includes(card.rank)) return false
    const key = cardKey(card)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

function clamp01(value: number): number {
  return Math.min(0.999, Math.max(0.001, value))
}

function positionAdjustment(position: BotPosition | undefined): number {
  if (position === 'LATE' || position === 'DEALER') return 0.06
  if (position === 'EARLY') return -0.06
  if (position === 'SMALL_BLIND') return -0.03
  if (position === 'BIG_BLIND') return 0.01
  return 0
}

function contextPosition(context: BotDecisionContext): BotPosition | undefined {
  if (context.position) return context.position
  if (context.seat !== undefined) {
    if (context.seat === context.dealerSeat) return 'DEALER'
    if (context.seat === context.smallBlindSeat) return 'SMALL_BLIND'
    if (context.seat === context.bigBlindSeat) return 'BIG_BLIND'
  }
  return undefined
}

function hasFlushDraw(cards: readonly Card[]): boolean {
  const counts = new Map<Card['suit'], number>()
  for (const card of cards) counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1)
  return [...counts.values()].some(count => count === 4)
}

function hasStraightDraw(cards: readonly Card[]): boolean {
  const ranks = new Set(cards.map(card => rankValue(card.rank)))
  if (ranks.has(14)) ranks.add(1)
  for (let high = 5; high <= 14; high += 1) {
    const present = [high - 4, high - 3, high - 2, high - 1, high].filter(rank => ranks.has(rank)).length
    if (present >= 4) return true
  }
  return false
}

function preflopStrength(holeCards: readonly Card[]): number {
  if (holeCards.length !== 2) return 0.18
  const first = rankValue(holeCards[0]!.rank)
  const second = rankValue(holeCards[1]!.rank)
  const high = Math.max(first, second)
  const low = Math.min(first, second)
  const pair = first === second
  const suited = holeCards[0]!.suit === holeCards[1]!.suit
  const connected = high - low <= 2
  let score = pair ? 0.47 + (high - 2) / 45 : 0.19 + (high - 2) / 35
  if (!pair && high >= 13 && low >= 10) score += 0.18
  if (suited) score += 0.06
  if (connected) score += 0.04
  if (high >= 12 && low >= 10) score += 0.05
  if (high === 14 && low <= 8) score -= 0.04
  return clamp01(score)
}

function categoryStrength(category: HandCategory, tieBreak: readonly number[]): number {
  const base: Readonly<Record<HandCategory, number>> = {
    'high-card': 0.16,
    'one-pair': 0.35,
    'two-pair': 0.53,
    'three-of-a-kind': 0.68,
    straight: 0.76,
    flush: 0.8,
    'full-house': 0.91,
    'four-of-a-kind': 0.98,
    'straight-flush': 0.997
  }
  const kicker = (tieBreak[0] ?? 8) / 14
  return clamp01(base[category] + kicker * 0.035)
}

function calculateStrength(context: BotDecisionContext): { strength: number; draw: boolean; valid: boolean } {
  if (!validCards([...context.holeCards, ...context.board]) || context.holeCards.length !== 2 || !validCards(context.board)) {
    return { strength: 0.2, draw: false, valid: false }
  }
  if (context.street === 'PREFLOP' || context.board.length === 0) {
    return { strength: preflopStrength(context.holeCards), draw: false, valid: true }
  }
  if (context.board.length < 3 || context.board.length > 5) return { strength: preflopStrength(context.holeCards), draw: false, valid: false }
  try {
    const evaluation = evaluateHand([...context.holeCards, ...context.board])
    const draw = evaluation.category === 'high-card' || evaluation.category === 'one-pair'
      ? hasFlushDraw([...context.holeCards, ...context.board]) || hasStraightDraw([...context.holeCards, ...context.board])
      : false
    return { strength: categoryStrength(evaluation.category, evaluation.tieBreak), draw, valid: true }
  } catch {
    return { strength: 0.2, draw: false, valid: false }
  }
}

function inferLegalActions(context: BotDecisionContext): BettingActionType[] {
  const actions: BettingActionType[] = ['fold']
  if (context.toCall <= 0) actions.push('check')
  else if (context.toCall <= context.stack) actions.push('call')
  if (context.currentBet === 0 && context.stack > 0) actions.push('bet')
  if (context.currentBet > 0 && context.stack + context.streetContribution > context.currentBet) actions.push('raise')
  if (context.stack > 0) actions.push('all-in')
  return actions
}

function legalActions(context: BotDecisionContext): Set<BettingActionType> {
  const source = context.legalActions?.length ? context.legalActions : inferLegalActions(context)
  return new Set(source.filter(action => (BETTING_ACTION_TYPES as readonly string[]).includes(action)))
}

function maxTarget(context: BotDecisionContext): number {
  return Math.max(0, context.streetContribution + context.stack)
}

function makeDecision(context: BotDecisionContext, type: BettingActionType, rationale: BotDecision['rationale'], strength: number, potOdds: number, amount?: number): BotDecision {
  return Object.freeze({
    playerId: context.playerId,
    type,
    ...(amount === undefined ? {} : { amount }),
    strength: Number(strength.toFixed(4)),
    potOdds: Number(potOdds.toFixed(4)),
    rationale
  })
}

function safeFallback(context: BotDecisionContext, actions: Set<BettingActionType>, strength = 0.2, potOdds = 0): BotDecision {
  if (context.toCall <= 0 && actions.has('check')) return makeDecision(context, 'check', 'fallback', strength, potOdds)
  if (context.toCall > 0 && actions.has('call') && context.toCall <= context.stack) return makeDecision(context, 'call', 'fallback', strength, potOdds)
  if (actions.has('fold')) return makeDecision(context, 'fold', 'fallback', strength, potOdds)
  const allInIsCallOrOpening = context.currentBet === 0 || maxTarget(context) <= context.currentBet
  if (actions.has('all-in') && context.stack > 0 && (context.raiseReopened !== false || allInIsCallOrOpening)) return makeDecision(context, 'all-in', 'fallback', strength, potOdds)
  if (actions.has('check')) return makeDecision(context, 'check', 'fallback', strength, potOdds)
  for (const action of BETTING_ACTION_TYPES) {
    if (action === 'all-in' && context.raiseReopened === false && !allInIsCallOrOpening) continue
    if (actions.has(action)) return makeDecision(context, action, 'fallback', strength, potOdds)
  }
  // An empty legal-action set is malformed server context. Keep the output
  // deterministic; the authoritative betting engine will reject it.
  return makeDecision(context, 'fold', 'fallback', strength, potOdds)
}

function betTarget(context: BotDecisionContext, strength: number, aggression: number, random: number): number {
  const minimum = Math.max(1, context.minBet ?? context.bigBlind)
  const maximum = maxTarget(context)
  const bucket = random < 0.25 ? 0.3 : random < 0.65 ? 0.5 : random < 0.9 ? 0.7 : 1
  const potSizing = bucket + aggression * 0.22 + strength * 0.12
  const target = Math.round(Math.max(minimum, context.pot * potSizing + context.bigBlind * 0.25))
  return Math.min(maximum, Math.max(minimum, target))
}

function raiseTarget(context: BotDecisionContext, strength: number, aggression: number, random: number): number {
  const minimum = Math.max(context.currentBet + 1, context.minRaiseTo ?? context.currentBet + context.bigBlind)
  const maximum = maxTarget(context)
  const raiseSize = Math.max(1, minimum - context.currentBet)
  const bucket = random < 0.3 ? 1 : random < 0.75 ? 1.35 : 1.75
  const multiplier = bucket + aggression * 0.35 + strength * 0.2
  return Math.min(maximum, Math.max(minimum, Math.round(context.currentBet + raiseSize * multiplier)))
}

function priorAggression(context: BotDecisionContext): number {
  return (context.actionHistory ?? []).filter(action => action.street === context.street && (action.type === 'bet' || action.type === 'raise' || action.type === 'all-in')).length
}

function publicOpponentCount(context: BotDecisionContext): number {
  if (Number.isSafeInteger(context.activePlayers) && context.activePlayers! > 0) return Math.max(1, context.activePlayers! - 1)
  if (context.publicPlayers) {
    return Math.max(1, context.publicPlayers.filter(player => player.playerId !== context.playerId && player.status !== 'FOLDED' && player.status !== 'OUT').length)
  }
  return 1
}

function boardTextureAdjustment(context: BotDecisionContext, draw: boolean): number {
  const ranks = new Set(context.board.map(card => rankValue(card.rank)))
  const paired = ranks.size < context.board.length
  const wet = draw || hasFlushDraw([...context.holeCards, ...context.board]) || hasStraightDraw([...context.holeCards, ...context.board])
  return (wet ? 0.025 : 0) + (paired ? -0.025 : 0)
}

function profileValues(profile: BotDecisionProfile): { threshold: number; aggression: number; bluff: number; callBias: number } {
  const tier = VALID_TIERS.includes(profile.skillTier) ? TIER_PROFILE[profile.skillTier] : TIER_PROFILE.CASUAL
  const persistedStyle: BotPlayStyle = profile.playStyle === 'TAG' ? 'TIGHT_AGGRESSIVE' : profile.playStyle === 'LAG' ? 'LOOSE_AGGRESSIVE' : profile.playStyle
  const style = VALID_STYLES.includes(profile.playStyle) ? STYLE_PROFILE[persistedStyle] : STYLE_PROFILE.BALANCED
  return {
    threshold: tier.threshold + style.threshold,
    aggression: tier.aggression + style.aggression,
    bluff: style.bluff + tier.variance * 0.18,
    callBias: style.callBias - tier.threshold * 0.2
  }
}

/**
 * Chooses one bounded, server-validatable action from public context.
 * The function never sees an opponent's hole cards or the future deck.
 */
export function decideBotAction(
  context: BotDecisionContext,
  profile: BotDecisionProfile,
  rng: BotRandomSource = secureBotRandom
): BotDecision {
  const actions = legalActions(context)
  const { strength: rawStrength, draw, valid } = calculateStrength(context)
  const strength = clamp01(rawStrength)
  const values = profileValues(profile)
  const random = randomValue(rng)
  const position = positionAdjustment(contextPosition(context))
  const opponents = publicOpponentCount(context)
  const stackToPot = context.stack / Math.max(1, context.pot)
  const texture = boardTextureAdjustment(context, draw)
  const potOdds = context.pot + Math.max(0, context.toCall) > 0
    ? Math.min(1, Math.max(0, context.toCall) / (context.pot + Math.max(0, context.toCall)))
    : 0
  const aggression = values.aggression + position + Math.min(0.08, priorAggression(context) * 0.015)
  const effectiveStrength = clamp01(strength + (draw ? 0.1 : 0) + values.threshold * 0.18 + texture - Math.min(0.08, Math.max(0, opponents - 1) * 0.025))

  if (!valid) return safeFallback(context, actions, strength, potOdds)

  try {
    if (context.toCall <= 0) {
      const betChance = clamp01(0.08 + aggression + effectiveStrength * 0.56)
      if (actions.has('bet') && context.stack > 0 && random < betChance) {
        const target = betTarget(context, effectiveStrength, aggression, randomValue(rng))
        if (target >= (context.minBet ?? context.bigBlind) || target === maxTarget(context)) {
          return makeDecision(context, 'bet', effectiveStrength > 0.62 ? 'value-bet' : 'semi-bluff', strength, potOdds, target)
        }
      }
      if (actions.has('check')) return makeDecision(context, 'check', 'check', strength, potOdds)
      const allInIsCallOrOpening = context.currentBet === 0 || maxTarget(context) <= context.currentBet
      if (actions.has('all-in') && context.stack > 0 && (context.raiseReopened !== false || allInIsCallOrOpening)) return makeDecision(context, 'all-in', 'all-in', strength, potOdds)
      return safeFallback(context, actions, strength, potOdds)
    }

    const continueThreshold = clamp01(potOdds + 0.08 + values.threshold + values.callBias - position * 0.25 + (opponents - 1) * 0.025 - Math.min(0.04, Math.max(0, 1 - stackToPot) * 0.04))
    const canCall = actions.has('call') && context.toCall <= context.stack
    const canFullRaise = actions.has('raise') && maxTarget(context) >= (context.minRaiseTo ?? context.currentBet + context.bigBlind)
    const canFullAllIn = context.raiseReopened !== false && actions.has('all-in') && maxTarget(context) >= (context.minRaiseTo ?? context.currentBet + context.bigBlind)
    const canAllInCall = actions.has('all-in') && maxTarget(context) <= context.currentBet
    const bluff = random < values.bluff && effectiveStrength < 0.66 && aggression > 0.15
    const shouldContinue = effectiveStrength >= continueThreshold || bluff

    if (!shouldContinue) {
      if (canCall && random < 0.16 + values.callBias + (draw ? 0.12 : 0)) return makeDecision(context, 'call', 'call', strength, potOdds)
      if (actions.has('fold')) return makeDecision(context, 'fold', 'fold', strength, potOdds)
      return safeFallback(context, actions, strength, potOdds)
    }

    const raisePressure = 0.12 + aggression + effectiveStrength * 0.45 + (bluff ? 0.18 : 0)
    if ((canFullRaise || canFullAllIn) && random < clamp01(raisePressure)) {
      const target = raiseTarget(context, effectiveStrength, aggression, randomValue(rng))
      if (target >= (context.minRaiseTo ?? context.currentBet + context.bigBlind)) {
        if (canFullAllIn && !canFullRaise) {
          return makeDecision(context, 'all-in', bluff ? 'semi-bluff' : 'all-in', strength, potOdds)
        }
        if (target === maxTarget(context) && canFullAllIn && randomValue(rng) < 0.45) {
          return makeDecision(context, 'all-in', bluff ? 'semi-bluff' : 'all-in', strength, potOdds)
        }
        return makeDecision(context, 'raise', bluff ? 'semi-bluff' : 'value-raise', strength, potOdds, target)
      }
    }

    if (canCall) return makeDecision(context, 'call', 'call', strength, potOdds)
    if (canAllInCall) return makeDecision(context, 'all-in', 'call', strength, potOdds)
    return safeFallback(context, actions, strength, potOdds)
  } catch {
    return safeFallback(context, actions, strength, potOdds)
  }
}
