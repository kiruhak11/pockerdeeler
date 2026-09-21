import { RANKS, SUITS, type Card, type Rank, type Suit } from './pokerDeck'

export const HAND_CATEGORIES = [
  'high-card',
  'one-pair',
  'two-pair',
  'three-of-a-kind',
  'straight',
  'flush',
  'full-house',
  'four-of-a-kind',
  'straight-flush'
] as const

export type HandCategory = typeof HAND_CATEGORIES[number]

export const HAND_CATEGORY_RANK: Readonly<Record<HandCategory, number>> = Object.freeze({
  'high-card': 0,
  'one-pair': 1,
  'two-pair': 2,
  'three-of-a-kind': 3,
  straight: 4,
  flush: 5,
  'full-house': 6,
  'four-of-a-kind': 7,
  'straight-flush': 8
})

export type HandEvaluation = Readonly<{
  category: HandCategory
  categoryRank: number
  bestFive: readonly Card[]
  tieBreak: readonly number[]
}>

const RANK_VALUES: Readonly<Record<Rank, number>> = Object.freeze({
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14
})

const SUIT_VALUES: Readonly<Record<Suit, number>> = Object.freeze({
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3
})

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function assertValidCard(card: Card): void {
  if (!SUITS.includes(card.suit) || !RANKS.includes(card.rank)) {
    throw new Error(`Invalid card: ${String(card.rank)} of ${String(card.suit)}`)
  }
}

function rankValue(rank: Rank): number {
  return RANK_VALUES[rank]
}

function canonicalCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((left, right) => {
    const rankDifference = rankValue(right.rank) - rankValue(left.rank)
    return rankDifference || SUIT_VALUES[left.suit] - SUIT_VALUES[right.suit]
  })
}

function sortedRanks(cards: readonly Card[]): number[] {
  return cards.map(card => rankValue(card.rank)).sort((left, right) => right - left)
}

function straightHigh(ranks: readonly number[]): number | null {
  const unique = [...new Set(ranks)]
  if (unique.length !== 5) return null

  const descending = unique.sort((left, right) => right - left)
  if (descending[0] === 14 && descending[1] === 5 && descending[2] === 4 && descending[3] === 3 && descending[4] === 2) {
    return 5
  }

  for (let index = 1; index < descending.length; index += 1) {
    if (descending[index - 1]! - descending[index]! !== 1) return null
  }
  return descending[0]!
}

function rankGroups(cards: readonly Card[]): Array<[rank: number, count: number]> {
  const counts = new Map<number, number>()
  for (const card of cards) {
    const value = rankValue(card.rank)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])
}

function makeEvaluation(category: HandCategory, cards: readonly Card[], tieBreak: readonly number[]): HandEvaluation {
  return Object.freeze({
    category,
    categoryRank: HAND_CATEGORY_RANK[category],
    bestFive: Object.freeze(canonicalCards(cards)),
    tieBreak: Object.freeze([...tieBreak])
  })
}

function evaluateFive(cards: readonly Card[]): HandEvaluation {
  const canonical = canonicalCards(cards)
  const ranks = sortedRanks(canonical)
  const groups = rankGroups(canonical)
  const flush = canonical.every(card => card.suit === canonical[0]!.suit)
  const high = straightHigh(ranks)

  if (flush && high !== null) return makeEvaluation('straight-flush', canonical, [high])

  if (groups[0]![1] === 4) {
    return makeEvaluation('four-of-a-kind', canonical, [groups[0]![0], groups[1]![0]])
  }

  if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    return makeEvaluation('full-house', canonical, [groups[0]![0], groups[1]![0]])
  }

  if (flush) return makeEvaluation('flush', canonical, ranks)
  if (high !== null) return makeEvaluation('straight', canonical, [high])

  if (groups[0]![1] === 3) {
    const kickers = groups.filter(([, count]) => count === 1).map(([rank]) => rank).sort((left, right) => right - left)
    return makeEvaluation('three-of-a-kind', canonical, [groups[0]![0], ...kickers])
  }

  const pairs = groups.filter(([, count]) => count === 2).map(([rank]) => rank).sort((left, right) => right - left)
  if (pairs.length === 2) {
    const kicker = groups.find(([, count]) => count === 1)![0]
    return makeEvaluation('two-pair', canonical, [pairs[0]!, pairs[1]!, kicker])
  }

  if (pairs.length === 1) {
    const kickers = groups.filter(([, count]) => count === 1).map(([rank]) => rank).sort((left, right) => right - left)
    return makeEvaluation('one-pair', canonical, [pairs[0]!, ...kickers])
  }

  return makeEvaluation('high-card', canonical, ranks)
}

function combinations(cards: readonly Card[], choose: number): Card[][] {
  const result: Card[][] = []
  const current: Card[] = []

  function visit(start: number): void {
    if (current.length === choose) {
      result.push([...current])
      return
    }

    const needed = choose - current.length
    for (let index = start; index <= cards.length - needed; index += 1) {
      current.push(cards[index]!)
      visit(index + 1)
      current.pop()
    }
  }

  visit(0)
  return result
}

function compareCanonicalBestFive(left: HandEvaluation, right: HandEvaluation): number {
  const leftCards = left.bestFive
  const rightCards = right.bestFive
  for (let index = 0; index < leftCards.length; index += 1) {
    const leftCard = leftCards[index]!
    const rightCard = rightCards[index]!
    const rankDifference = rankValue(leftCard.rank) - rankValue(rightCard.rank)
    if (rankDifference) return rankDifference
    const suitDifference = SUIT_VALUES[leftCard.suit] - SUIT_VALUES[rightCard.suit]
    if (suitDifference) return suitDifference
  }
  return 0
}

/** Returns a positive value when left wins, a negative value when right wins, and 0 for an exact tie. */
export function compareHands(left: HandEvaluation, right: HandEvaluation): number {
  const categoryDifference = left.categoryRank - right.categoryRank
  if (categoryDifference) return categoryDifference

  const length = Math.max(left.tieBreak.length, right.tieBreak.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left.tieBreak[index] ?? 0) - (right.tieBreak[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/** Evaluates 5 to 7 unique cards and returns the strongest possible five-card hand. */
export function evaluateHand(cards: readonly Card[]): HandEvaluation {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error('A poker hand must contain between 5 and 7 cards.')
  }

  const seen = new Set<string>()
  for (const card of cards) {
    assertValidCard(card)
    const key = cardKey(card)
    if (seen.has(key)) throw new Error(`Duplicate physical card in hand: ${key}`)
    seen.add(key)
  }

  let best: HandEvaluation | undefined
  for (const fiveCards of combinations(cards, 5)) {
    const candidate = evaluateFive(fiveCards)
    if (!best) {
      best = candidate
      continue
    }

    const comparison = compareHands(candidate, best)
    if (comparison > 0 || (comparison === 0 && compareCanonicalBestFive(candidate, best) < 0)) {
      best = candidate
    }
  }

  return best!
}
