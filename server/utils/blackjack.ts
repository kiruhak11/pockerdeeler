import { randomInt } from 'node:crypto'

export const BLACKJACK_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const)
export const BLACKJACK_SUITS = Object.freeze(['S', 'H', 'D', 'C'] as const)
export type BlackjackRank = typeof BLACKJACK_RANKS[number]
export type BlackjackSuit = typeof BLACKJACK_SUITS[number]
export type BlackjackCard = Readonly<{ rank: BlackjackRank; suit: BlackjackSuit; code: string }>
export type BlackjackOutcome = 'WIN' | 'LOSE' | 'PUSH' | 'BLACKJACK'
export type BlackjackHandValue = Readonly<{ total: number; soft: boolean; natural: boolean; bust: boolean }>

export function createBlackjackDeck(randomIndex: (upperExclusive: number) => number = upper => randomInt(upper)): BlackjackCard[] {
  const deck = BLACKJACK_SUITS.flatMap(suit => BLACKJACK_RANKS.map(rank => ({ rank, suit, code: `${rank}${suit}` })))
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const other = randomIndex(index + 1)
    if (!Number.isInteger(other) || other < 0 || other > index) throw new RangeError('Blackjack shuffle source returned an invalid index.')
    ;[deck[index], deck[other]] = [deck[other]!, deck[index]!]
  }
  return deck
}

export function blackjackHandValue(cards: readonly BlackjackCard[]): BlackjackHandValue {
  let total = 0
  let aces = 0
  for (const card of cards) {
    if (card.rank === 'A') { total += 11; aces += 1 }
    else if (card.rank === 'K' || card.rank === 'Q' || card.rank === 'J') total += 10
    else total += Number(card.rank)
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1 }
  const soft = total <= 21 && aces > 0
  return { total, soft, natural: cards.length === 2 && total === 21, bust: total > 21 }
}

export function dealerShouldHit(cards: readonly BlackjackCard[]): boolean {
  return blackjackHandValue(cards).total < 17
}

export function playDealerHand(initial: readonly BlackjackCard[], draw: () => BlackjackCard): BlackjackCard[] {
  const cards = [...initial]
  while (dealerShouldHit(cards)) cards.push(draw())
  return cards
}

export function resolveBlackjackOutcome(player: readonly BlackjackCard[], dealer: readonly BlackjackCard[]): BlackjackOutcome {
  const playerValue = blackjackHandValue(player)
  const dealerValue = blackjackHandValue(dealer)
  if (playerValue.bust) return 'LOSE'
  if (playerValue.natural || dealerValue.natural) {
    if (playerValue.natural && dealerValue.natural) return 'PUSH'
    return playerValue.natural ? 'BLACKJACK' : 'LOSE'
  }
  if (dealerValue.bust || playerValue.total > dealerValue.total) return 'WIN'
  if (playerValue.total < dealerValue.total) return 'LOSE'
  return 'PUSH'
}

export function resolveInitialBlackjack(player: readonly BlackjackCard[], dealer: readonly BlackjackCard[]): BlackjackOutcome | null {
  const playerNatural = blackjackHandValue(player).natural
  const dealerNatural = blackjackHandValue(dealer).natural
  if (!playerNatural && !dealerNatural) return null
  return resolveBlackjackOutcome(player, dealer)
}

/** Gross wallet return: stake is included in 1:1 wins and 3:2 naturals. */
export function blackjackPayout(outcome: BlackjackOutcome, stake: bigint): bigint {
  if (stake <= 0n || stake % 2n !== 0n) throw new RangeError('Blackjack stake must be a positive even number of chips.')
  if (outcome === 'WIN') return stake * 2n
  if (outcome === 'BLACKJACK') return stake * 5n / 2n
  if (outcome === 'PUSH') return stake
  return 0n
}
