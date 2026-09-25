import type { Card } from './pokerDeck'
import { buildPots, type PotBuildResult, type ReturnedExcess } from './pokerPotBuilder'
import type { InternalHandState } from './pokerHandState'
import { resolvePayout, type PayoutPlayer, type PayoutPlayerResult, type PlayerPayout, type PotPayout } from './pokerPayout'
import { resolveShowdown, type ShowdownPlayer, type ShowdownResult } from './pokerShowdown'

export const HAND_FINISH_TYPES = ['CONTESTED', 'UNCONTESTED'] as const
export type HandFinishType = typeof HAND_FINISH_TYPES[number]

export const HAND_FINISH_REASONS = ['SHOWDOWN', 'UNCONTESTED_FOLD'] as const
export type HandFinishReason = typeof HAND_FINISH_REASONS[number]

export type UncontestedFoldedContribution = Readonly<{
  sourcePlayerId: string
  winnerPlayerId: string
  amount: number
}>

export type HandFinalizationResult = Readonly<{
  handId: string
  type: HandFinishType
  reason: HandFinishReason
  street: 'FINISHED'
  board: readonly Card[]
  players: readonly PayoutPlayerResult[]
  pots: readonly PotPayout[]
  payouts: readonly PlayerPayout[]
  returnedExcess: readonly ReturnedExcess[]
  potBuild: PotBuildResult
  showdown: ShowdownResult | null
  uncontestedFoldedContributions: readonly UncontestedFoldedContribution[]
  totalPayout: number
  totalReturnedExcess: number
}>

function safeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`)
}

function playerForId(state: InternalHandState, playerId: string): PayoutPlayer {
  const player = state.players.find(candidate => candidate.playerId === playerId)
  if (!player) throw new Error(`Unknown hand player ${playerId}.`)
  return player
}

function buildPotInput(state: InternalHandState) {
  return state.players.map(player => ({
    playerId: player.playerId,
    contribution: player.contribution,
    status: player.status
  }))
}

function payoutPlayers(state: InternalHandState): PayoutPlayer[] {
  return state.players.map(player => ({
    playerId: player.playerId,
    seat: player.seat,
    stack: player.stack,
    status: player.status
  }))
}

function showdownPlayers(state: InternalHandState): ShowdownPlayer[] {
  return state.players.map(player => ({
    playerId: player.playerId,
    status: player.status,
    holeCards: player.holeCards
  }))
}

function totalStacks(players: readonly PayoutPlayerResult[]): number {
  const total = players.reduce((sum, player) => sum + player.stack, 0)
  safeNonNegative(total, 'Final stack total')
  return total
}

function totalBeforeFinalization(state: InternalHandState): number {
  const total = state.players.reduce((sum, player) => sum + player.stack + player.contribution, 0)
  safeNonNegative(total, 'Pre-finalization chip total')
  return total
}

function assertReadyState(state: InternalHandState): void {
  if (!state || !Array.isArray(state.players)) throw new Error('Hand finalization requires a valid hand state.')
  if (!state.bettingRoundComplete) throw new Error('Betting round must be complete before finishing the hand.')
  if (state.currentActor !== null) throw new Error('A completed betting round cannot have a current actor.')

  const contributionTotal = state.players.reduce((sum, player) => sum + player.contribution, 0)
  safeNonNegative(contributionTotal, 'Contribution total')
  for (const player of state.players) {
    safeNonNegative(player.stack, `Stack for ${player.playerId}`)
    safeNonNegative(player.contribution, `Contribution for ${player.playerId}`)
  }
  if (state.pot !== contributionTotal) throw new Error('Hand pot does not match player contributions.')
  if (new Set(state.players.map(player => player.playerId)).size !== state.players.length) {
    throw new Error('Hand player ids must be unique.')
  }
  if (new Set(state.players.map(player => player.seat)).size !== state.players.length) {
    throw new Error('Hand seats must be unique.')
  }
}

function resultPlayers(
  state: InternalHandState,
  payoutsByPlayer: ReadonlyMap<string, number>,
  returnedByPlayer: ReadonlyMap<string, number>
): PayoutPlayerResult[] {
  return [...state.players]
    .sort((left, right) => left.seat - right.seat)
    .map(player => {
      const payout = payoutsByPlayer.get(player.playerId) ?? 0
      const returnedExcess = returnedByPlayer.get(player.playerId) ?? 0
      safeNonNegative(payout, `Payout for ${player.playerId}`)
      safeNonNegative(returnedExcess, `Returned excess for ${player.playerId}`)
      const stack = player.stack + payout + returnedExcess
      safeNonNegative(stack, `Final stack for ${player.playerId}`)
      return Object.freeze({
        playerId: player.playerId,
        seat: player.seat,
        status: player.status,
        stack,
        payout,
        returnedExcess
      })
    })
}

function assertChipConservation(state: InternalHandState, players: readonly PayoutPlayerResult[]): void {
  if (totalBeforeFinalization(state) !== totalStacks(players)) {
    throw new Error('Hand finalization failed chip conservation.')
  }
}

function finishUncontested(
  state: InternalHandState,
  built: PotBuildResult,
  winner: PayoutPlayer
): HandFinalizationResult {
  const winnerId = winner.playerId
  const winnerStatus = new Map(state.players.map(player => [player.playerId, player.status]))
  const potTotal = built.pots.reduce((sum, pot) => sum + pot.amount, 0)
  const foldedExcess = built.returnedExcess.filter(item => {
    const status = winnerStatus.get(item.playerId)
    return status === 'FOLDED' || status === 'OUT'
  })
  const winnerExcess = built.returnedExcess.filter(item => item.playerId === winnerId)
  const foldedExcessTotal = foldedExcess.reduce((sum, item) => sum + item.amount, 0)
  const totalPayout = potTotal + foldedExcessTotal

  safeNonNegative(potTotal, 'Contested pot total')
  safeNonNegative(foldedExcessTotal, 'Folded contribution total')
  safeNonNegative(totalPayout, 'Uncontested payout total')

  const potPayouts = built.pots.map(pot => Object.freeze({
    potId: pot.id,
    amount: pot.amount,
    contributorPlayerIds: Object.freeze([...pot.contributorPlayerIds]),
    eligiblePlayerIds: Object.freeze([...pot.eligiblePlayerIds]),
    foldedPlayerIds: Object.freeze(pot.contributorPlayerIds.filter(playerId => winnerStatus.get(playerId) === 'FOLDED')),
    winnerIds: Object.freeze([winnerId]),
    split: false,
    oddChipCount: 0,
    oddChipRecipients: Object.freeze([]),
    payouts: Object.freeze([Object.freeze({ playerId: winnerId, amount: pot.amount })])
  }))

  const payoutsByPlayer = new Map<string, number>([[winnerId, totalPayout]])
  const returnedByPlayer = new Map<string, number>(winnerExcess.map(item => [item.playerId, item.amount]))
  const players = resultPlayers(state, payoutsByPlayer, returnedByPlayer)
  assertChipConservation(state, players)

  const payouts = [...state.players]
    .sort((left, right) => left.seat - right.seat)
    .map(player => Object.freeze({ playerId: player.playerId, amount: payoutsByPlayer.get(player.playerId) ?? 0 }))
  const returnedExcess = Object.freeze(winnerExcess.map(item => Object.freeze({ ...item })))
  const uncontestedFoldedContributions = Object.freeze(foldedExcess.map(item => Object.freeze({
    sourcePlayerId: item.playerId,
    winnerPlayerId: winnerId,
    amount: item.amount
  })))
  const totalReturnedExcess = winnerExcess.reduce((sum, item) => sum + item.amount, 0)
  if (totalPayout + totalReturnedExcess !== built.totalContribution) {
    throw new Error('Uncontested hand failed chip conservation.')
  }

  return Object.freeze({
    handId: state.handId,
    type: 'UNCONTESTED' as const,
    reason: 'UNCONTESTED_FOLD' as const,
    street: 'FINISHED' as const,
    board: Object.freeze([...state.board]),
    players: Object.freeze(players),
    pots: Object.freeze(potPayouts),
    payouts: Object.freeze(payouts),
    returnedExcess,
    potBuild: built,
    showdown: null,
    uncontestedFoldedContributions,
    totalPayout,
    totalReturnedExcess
  })
}

/** Finalizes a server-owned hand through showdown+payout or an uncontested fold win. */
export function finishHand(state: InternalHandState): HandFinalizationResult {
  assertReadyState(state)
  const nonFoldedPlayers = state.players.filter(player => player.status !== 'FOLDED' && player.status !== 'OUT')
  if (nonFoldedPlayers.length === 0) throw new Error('Cannot finish a hand without a non-folded player.')

  const built = buildPots(buildPotInput(state))
  if (nonFoldedPlayers.length === 1) return finishUncontested(state, built, playerForId(state, nonFoldedPlayers[0]!.playerId))

  if (state.street !== 'SHOWDOWN') {
    throw new Error('Contested hand can only be finished at SHOWDOWN.')
  }
  if (state.board.length !== 5) throw new Error('Contested hand requires exactly 5 board cards.')

  const showdown = resolveShowdown(state.board, showdownPlayers(state), built)
  const payout = resolvePayout(payoutPlayers(state), built, showdown, state.dealerSeat)
  assertChipConservation(state, payout.players)

  return Object.freeze({
    handId: state.handId,
    type: 'CONTESTED' as const,
    reason: 'SHOWDOWN' as const,
    street: 'FINISHED' as const,
    board: Object.freeze([...state.board]),
    players: payout.players,
    pots: payout.potPayouts,
    payouts: payout.payouts,
    returnedExcess: payout.returnedExcess,
    potBuild: built,
    showdown,
    uncontestedFoldedContributions: Object.freeze([]),
    totalPayout: payout.totalPayout,
    totalReturnedExcess: payout.totalReturnedExcess
  })
}
