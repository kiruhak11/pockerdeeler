import { randomInt } from 'node:crypto'

export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export type Suit = typeof SUITS[number]

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const
export type Rank = typeof RANKS[number]

export type Card = Readonly<{
  suit: Suit
  rank: Rank
}>

export type DeckSnapshot = Readonly<{
  cards: readonly Card[]
  position: number
}>

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function assertValidCard(card: Card): void {
  if (!SUITS.includes(card.suit) || !RANKS.includes(card.rank)) {
    throw new Error(`Invalid card: ${String(card.rank)} of ${String(card.suit)}`)
  }
}

function standardCards(): Card[] {
  return SUITS.flatMap(suit => RANKS.map(rank => Object.freeze({ suit, rank })))
}

function shuffledCards(cards: readonly Card[]): Card[] {
  const shuffled = [...cards]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!]
  }
  return shuffled
}

export class Deck {
  private readonly sequence: readonly Card[]
  private position = 0

  constructor(cards: readonly Card[]) {
    const seen = new Set<string>()
    this.sequence = cards.map(card => {
      assertValidCard(card)
      const copy = Object.freeze({ suit: card.suit, rank: card.rank })
      const key = cardKey(copy)
      if (seen.has(key)) throw new Error(`Duplicate card in deck: ${key}`)
      seen.add(key)
      return copy
    })
  }

  get size(): number {
    return this.sequence.length
  }

  get dealtCount(): number {
    return this.position
  }

  get remainingCount(): number {
    return this.sequence.length - this.position
  }

  get availableCards(): readonly Card[] {
    return this.sequence.slice(this.position)
  }

  snapshot(): DeckSnapshot {
    return Object.freeze({
      cards: Object.freeze(this.sequence.map(card => Object.freeze({ ...card }))),
      position: this.position
    })
  }

  hasAvailable(card: Card): boolean {
    return this.availableCards.some(candidate => candidate.suit === card.suit && candidate.rank === card.rank)
  }

  deal(): Card {
    const card = this.sequence[this.position]
    if (!card) throw new Error('Cannot deal from an empty deck.')
    this.position += 1
    return card
  }

  dealMany(count: number): Card[] {
    if (!Number.isInteger(count) || count < 0) throw new Error('The number of cards to deal must be a non-negative integer.')
    if (count > this.remainingCount) throw new Error('Cannot deal more cards than remain in the deck.')
    return Array.from({ length: count }, () => this.deal())
  }
}

/** Captures the server-owned deck sequence and cursor without exposing mutable references. */
export function snapshotDeck(deck: Deck): DeckSnapshot {
  if (!(deck instanceof Deck)) throw new Error('A valid deck is required.')
  return deck.snapshot()
}

/** Restores a deck snapshot while validating cards and cursor bounds. */
export function restoreDeck(snapshot: DeckSnapshot): Deck {
  if (!snapshot || !Array.isArray(snapshot.cards) || !Number.isSafeInteger(snapshot.position)) {
    throw new Error('Invalid deck snapshot.')
  }
  if (snapshot.position < 0 || snapshot.position > snapshot.cards.length) {
    throw new Error('Invalid deck snapshot position.')
  }
  const deck = new Deck(snapshot.cards)
  for (let index = 0; index < snapshot.position; index += 1) deck.deal()
  return deck
}

export function createStandardDeck(): Deck {
  return new Deck(standardCards())
}

export function createShuffledDeck(): Deck {
  return new Deck(shuffledCards(standardCards()))
}

export function createPredefinedDeck(cards: readonly Card[]): Deck {
  return new Deck(cards)
}
