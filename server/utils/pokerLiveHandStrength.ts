import { evaluateHand, HAND_CATEGORY_RANK, type HandCategory, type HandEvaluation } from './pokerHandEvaluator'
import { RANKS, type Card, type Rank } from './pokerDeck'
import type { InternalHandState } from './pokerHandState'

export const HAND_CATEGORY_LABELS: Readonly<Record<HandCategory, string>> = Object.freeze({
  'high-card': 'Старшая карта',
  'one-pair': 'Пара',
  'two-pair': 'Две пары',
  'three-of-a-kind': 'Сет',
  straight: 'Стрит',
  flush: 'Флеш',
  'full-house': 'Фулл-хаус',
  'four-of-a-kind': 'Каре',
  'straight-flush': 'Стрит-флеш'
})

export type LiveHandStrength = Readonly<{
  category: HandCategory
  categoryRank: number
  label: string
  contributingCardIds: readonly string[]
}>

/** Stable public identity used to match a safe card with the server summary. */
export function pokerCardId(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank) + 2
}

function freezeResult(category: HandCategory, contributingCards: readonly Card[]): LiveHandStrength {
  const ids = Object.freeze(contributingCards.map(pokerCardId))
  return Object.freeze({
    category,
    categoryRank: HAND_CATEGORY_RANK[category],
    label: HAND_CATEGORY_LABELS[category],
    contributingCardIds: ids
  })
}

function preflopStrength(holeCards: readonly Card[]): LiveHandStrength {
  if (holeCards.length !== 2) throw new Error('Live hand strength requires two hole cards.')
  if (holeCards[0]!.rank === holeCards[1]!.rank) return freezeResult('one-pair', holeCards)
  const highCard = rankValue(holeCards[0]!.rank) >= rankValue(holeCards[1]!.rank) ? holeCards[0]! : holeCards[1]!
  return freezeResult('high-card', [highCard])
}

function preferredRankCards(rank: number, required: number, board: readonly Card[], holeCards: readonly Card[]): Card[] {
  return [...board, ...holeCards].filter(card => rankValue(card.rank) === rank).slice(0, required)
}

export function structuralCards(
  category: HandCategory,
  bestFive: readonly Card[],
  tieBreak: readonly number[],
  board: readonly Card[],
  holeCards: readonly Card[]
): readonly Card[] {
  switch (category) {
    case 'high-card':
      return preferredRankCards(rankValue(bestFive[0]!.rank), 1, board, holeCards)
    case 'one-pair':
      return preferredRankCards(tieBreak[0]!, 2, board, holeCards)
    case 'two-pair':
      return tieBreak.slice(0, 2).flatMap(rank => preferredRankCards(rank!, 2, board, holeCards))
    case 'three-of-a-kind':
      return preferredRankCards(tieBreak[0]!, 3, board, holeCards)
    case 'full-house':
      return tieBreak.slice(0, 2).flatMap(rank => preferredRankCards(rank!, bestFive.filter(card => rankValue(card.rank) === rank).length, board, holeCards))
    case 'four-of-a-kind':
      return preferredRankCards(tieBreak[0]!, 4, board, holeCards)
    case 'straight':
      {
        const high = tieBreak[0]!
        const sequence = high === 5 ? [14, 2, 3, 4, 5] : [high - 4, high - 3, high - 2, high - 1, high]
        return sequence.flatMap(rank => preferredRankCards(rank, 1, board, holeCards))
      }
    case 'flush':
    case 'straight-flush':
      return bestFive
  }
}

/** Returns the server-selected structural cards without exposing evaluator internals. */
export function contributingCardIdsForEvaluation(
  evaluation: HandEvaluation,
  board: readonly Card[],
  holeCards: readonly Card[]
): readonly string[] {
  return Object.freeze(structuralCards(evaluation.category, evaluation.bestFive, evaluation.tieBreak, board, holeCards).map(pokerCardId))
}

/** Evaluates the viewer's current hand without exposing evaluator internals. */
export function evaluateLiveHand(holeCards: readonly Card[], board: readonly Card[]): LiveHandStrength {
  if (holeCards.length !== 2) throw new Error('Live hand strength requires two hole cards.')
  if (board.length === 0) return preflopStrength(holeCards)
  const cards = [...holeCards, ...board]
  if (cards.length < 5 || cards.length > 7) throw new Error('Live postflop hand must contain five to seven cards.')
  const evaluation = evaluateHand(cards)
  return freezeResult(evaluation.category, structuralCards(evaluation.category, evaluation.bestFive, evaluation.tieBreak, board, holeCards))
}

/** Returns only the authenticated viewer's live summary for an active hand. */
export function getViewerLiveHandStrength(hand: InternalHandState, viewerPlayerId?: string): LiveHandStrength | null {
  if (!viewerPlayerId || hand.street === 'SHOWDOWN' || hand.street === 'FINISHED') return null
  const player = hand.players.find(candidate => candidate.playerId === viewerPlayerId)
  if (!player || player.status === 'FOLDED' || player.status === 'OUT') return null
  return evaluateLiveHand(player.holeCards, hand.board)
}
