import { RANKS, SUITS, type Card } from './pokerDeck'
import { compareHands, evaluateHand, type HandEvaluation } from './pokerHandEvaluator'
import type { HandPlayerState } from './pokerHandState'
import type { BuiltPot, PotBuildResult, ReturnedExcess } from './pokerPotBuilder'

export type ShowdownPlayer = Pick<HandPlayerState, 'playerId' | 'status' | 'holeCards'>

export type ShowdownPlayerEvaluation = Readonly<{
  playerId: string
  evaluation: HandEvaluation
}>

export type ResolvedPot = Readonly<{
  id: number
  amount: number
  eligiblePlayerIds: readonly string[]
  evaluations: readonly ShowdownPlayerEvaluation[]
  winners: readonly string[]
  tie: boolean
}>

export type ShowdownResult = Readonly<{
  pots: readonly ResolvedPot[]
  returnedExcess: readonly ReturnedExcess[]
}>

function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}

function assertCard(card: Card, seen: Set<string>): void {
  if (!card || !SUITS.includes(card.suit) || !RANKS.includes(card.rank)) {
    throw new Error('Showdown contains an invalid card.')
  }
  const key = cardKey(card)
  if (seen.has(key)) throw new Error(`Duplicate physical card in showdown: ${key}`)
  seen.add(key)
}

function assertPot(pot: BuiltPot, playerIds: Set<string>, seenPotIds: Set<number>): void {
  if (!Number.isSafeInteger(pot.id) || pot.id <= 0 || seenPotIds.has(pot.id)) {
    throw new Error('Showdown pots must have unique positive ids.')
  }
  seenPotIds.add(pot.id)
  if (!Number.isSafeInteger(pot.amount) || pot.amount <= 0) throw new Error(`Pot ${pot.id} has an invalid amount.`)

  const contributorIds = new Set(pot.contributorPlayerIds)
  const eligibleIds = new Set(pot.eligiblePlayerIds)
  if (eligibleIds.size === 0) throw new Error(`Pot ${pot.id} has no eligible players.`)
  if (eligibleIds.size !== pot.eligiblePlayerIds.length) throw new Error(`Pot ${pot.id} has duplicate eligible players.`)
  for (const playerId of pot.contributorPlayerIds) {
    if (!playerIds.has(playerId)) throw new Error(`Pot ${pot.id} references an unknown contributor.`)
  }
  for (const playerId of pot.eligiblePlayerIds) {
    if (!contributorIds.has(playerId) || !playerIds.has(playerId)) {
      throw new Error(`Pot ${pot.id} references an invalid eligible player.`)
    }
  }
}

function evaluateEligiblePlayers(
  board: readonly Card[],
  playersById: ReadonlyMap<string, ShowdownPlayer>,
  eligiblePlayerIds: readonly string[],
  cache: Map<string, HandEvaluation>
): ShowdownPlayerEvaluation[] {
  return eligiblePlayerIds.map(playerId => {
    const player = playersById.get(playerId)
    if (!player) throw new Error(`Showdown references unknown player: ${playerId}`)
    if (player.status === 'FOLDED' || player.status === 'OUT') {
      throw new Error(`Folded player ${playerId} cannot be eligible for showdown.`)
    }
    let evaluation = cache.get(playerId)
    if (!evaluation) {
      evaluation = evaluateHand([...board, ...player.holeCards])
      cache.set(playerId, evaluation)
    }
    return Object.freeze({ playerId, evaluation })
  })
}

function resolvePot(pot: BuiltPot, evaluations: readonly ShowdownPlayerEvaluation[]): ResolvedPot {
  let best: HandEvaluation | undefined
  const winners: string[] = []
  for (const item of evaluations) {
    if (!best) {
      best = item.evaluation
      winners.push(item.playerId)
      continue
    }
    const comparison = compareHands(item.evaluation, best)
    if (comparison > 0) {
      best = item.evaluation
      winners.splice(0, winners.length, item.playerId)
    } else if (comparison === 0) {
      winners.push(item.playerId)
    }
  }

  if (winners.length === 0) throw new Error(`Pot ${pot.id} has no showdown winner.`)
  return Object.freeze({
    id: pot.id,
    amount: pot.amount,
    eligiblePlayerIds: Object.freeze([...pot.eligiblePlayerIds]),
    evaluations: Object.freeze([...evaluations]),
    winners: Object.freeze([...winners]),
    tie: winners.length > 1
  })
}

/** Resolves winners for already-built pots without changing stacks or paying chips. */
export function resolveShowdown(
  board: readonly Card[],
  players: readonly ShowdownPlayer[],
  builtPots: PotBuildResult
): ShowdownResult {
  if (board.length !== 5) throw new Error('Showdown requires exactly 5 community cards.')
  if (!builtPots || !Array.isArray(builtPots.pots)) throw new Error('Showdown requires a built pot result.')
  if (builtPots.pots.length === 0) throw new Error('Showdown requires at least one contested pot.')

  const playersById = new Map<string, ShowdownPlayer>()
  const seenCards = new Set<string>()
  for (const card of board) assertCard(card, seenCards)
  for (const player of players) {
    if (typeof player.playerId !== 'string' || player.playerId.trim().length === 0) throw new Error('Showdown player id must be non-empty.')
    if (playersById.has(player.playerId)) throw new Error('Showdown player ids must be unique.')
    if (!Array.isArray(player.holeCards) || player.holeCards.length !== 2) {
      throw new Error(`Player ${player.playerId} must have exactly 2 hole cards.`)
    }
    for (const card of player.holeCards) assertCard(card, seenCards)
    playersById.set(player.playerId, player)
  }

  const seenPotIds = new Set<number>()
  const cache = new Map<string, HandEvaluation>()
  const resolvedPots = builtPots.pots.map(pot => {
    assertPot(pot, new Set(playersById.keys()), seenPotIds)
    const evaluations = evaluateEligiblePlayers(board, playersById, pot.eligiblePlayerIds, cache)
    return resolvePot(pot, evaluations)
  })

  const returnedExcess = Object.freeze(builtPots.returnedExcess.map(item => Object.freeze({
    playerId: item.playerId,
    amount: item.amount
  })))
  return Object.freeze({
    pots: Object.freeze(resolvedPots),
    returnedExcess
  })
}
