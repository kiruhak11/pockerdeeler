import type { Card } from './pokerDeck'
import type { HandCategory, HandEvaluation } from './pokerHandEvaluator'
import { HAND_CATEGORY_LABELS, contributingCardIdsForEvaluation } from './pokerLiveHandStrength'
import type { HandPlayerState, InternalHandState } from './pokerHandState'
import type { HandFinalizationResult } from './pokerHandFinalizer'

export type FinalizedShowdownPlayer = Readonly<{
  playerId: string
  seat: number
  status: HandPlayerState['status']
  holeCards: readonly Card[]
  category: HandCategory | null
  categoryRank: number | null
  label: string | null
  contributingCardIds: readonly string[]
  payout: number
  returnedExcess: number
  winner: boolean
  nickname?: string
}>

export type FinalizedShowdownPot = Readonly<{
  potId: number
  amount: number
  winnerIds: readonly string[]
  split: boolean
  oddChipCount: number
  oddChipRecipients: readonly string[]
  payouts: readonly Readonly<{ playerId: string; amount: number }>[]
}>

export type FinalizedHandResult = Readonly<{
  handId: string
  type: HandFinalizationResult['type']
  reason: HandFinalizationResult['reason']
  board: readonly Card[]
  players: readonly FinalizedShowdownPlayer[]
  pots: readonly FinalizedShowdownPot[]
  returnedExcess: readonly Readonly<{ playerId: string; amount: number }>[]
  totalPayout: number
  totalReturnedExcess: number
}>

function payoutByPlayer(result: HandFinalizationResult): ReadonlyMap<string, number> {
  return new Map(result.payouts.map(item => [item.playerId, item.amount]))
}

function returnedByPlayer(result: HandFinalizationResult): ReadonlyMap<string, number> {
  return new Map(result.returnedExcess.map(item => [item.playerId, item.amount]))
}

function evaluationByPlayer(result: HandFinalizationResult): ReadonlyMap<string, HandEvaluation> {
  const evaluations = new Map<string, HandEvaluation>()
  for (const pot of result.showdown?.pots ?? []) {
    for (const item of pot.evaluations) {
      const existing = evaluations.get(item.playerId)
      if (existing && (existing.category !== item.evaluation.category || existing.tieBreak.some((value, index) => value !== item.evaluation.tieBreak[index]))) {
        throw new Error(`Inconsistent showdown evaluation for ${item.playerId}.`)
      }
      evaluations.set(item.playerId, item.evaluation)
    }
  }
  return evaluations
}

function winnerIds(result: HandFinalizationResult): ReadonlySet<string> {
  return new Set(result.pots.flatMap(pot => pot.winnerIds))
}

/** Builds the minimal finished-hand presentation from authoritative settlement data. */
export function buildFinalizedHandResult(hand: Readonly<Pick<InternalHandState, 'handId' | 'board' | 'players'>>, result: HandFinalizationResult): FinalizedHandResult {
  if (hand.handId !== result.handId) throw new Error('Finalized result hand id does not match the hand state.')

  const payouts = payoutByPlayer(result)
  const returned = returnedByPlayer(result)
  const winners = winnerIds(result)
  const evaluations = evaluationByPlayer(result)
  const players = hand.players
    .filter(player => result.type === 'CONTESTED' ? player.status !== 'FOLDED' && player.status !== 'OUT' : player.playerId === result.pots[0]?.winnerIds[0])
    .sort((left, right) => left.seat - right.seat)
    .map(player => {
      const evaluation = evaluations.get(player.playerId)
      if (result.type === 'CONTESTED' && !evaluation) throw new Error(`Missing showdown evaluation for ${player.playerId}.`)
      const contributingCardIds = evaluation
        ? contributingCardIdsForEvaluation(evaluation, hand.board, player.holeCards)
        : Object.freeze([])
      return Object.freeze({
        playerId: player.playerId,
        seat: player.seat,
        status: player.status,
        holeCards: result.type === 'CONTESTED' ? Object.freeze([...player.holeCards]) : Object.freeze([]),
        category: evaluation?.category ?? null,
        categoryRank: evaluation?.categoryRank ?? null,
        label: evaluation ? HAND_CATEGORY_LABELS[evaluation.category] : null,
        contributingCardIds,
        payout: payouts.get(player.playerId) ?? 0,
        returnedExcess: returned.get(player.playerId) ?? 0,
        winner: winners.has(player.playerId)
      })
    })

  return Object.freeze({
    handId: result.handId,
    type: result.type,
    reason: result.reason,
    board: Object.freeze([...result.board]),
    players: Object.freeze(players),
    pots: Object.freeze(result.pots.map(pot => Object.freeze({
      potId: pot.potId,
      amount: pot.amount,
      winnerIds: Object.freeze([...pot.winnerIds]),
      split: pot.split,
      oddChipCount: pot.oddChipCount,
      oddChipRecipients: Object.freeze([...pot.oddChipRecipients]),
      payouts: Object.freeze(pot.payouts.map(item => Object.freeze({ ...item })))
    }))),
    returnedExcess: Object.freeze(result.returnedExcess.map(item => Object.freeze({ ...item }))),
    totalPayout: result.totalPayout,
    totalReturnedExcess: result.totalReturnedExcess
  })
}
