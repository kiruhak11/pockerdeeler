import type { HandPlayerState } from './pokerHandState'
import type { BuiltPot, PotBuildResult, ReturnedExcess } from './pokerPotBuilder'
import type { ResolvedPot, ShowdownResult } from './pokerShowdown'

export type PayoutPlayer = Pick<HandPlayerState, 'playerId' | 'seat' | 'stack' | 'status'>

export type PlayerPayout = Readonly<{
  playerId: string
  amount: number
}>

export type PotPayout = Readonly<{
  potId: number
  amount: number
  contributorPlayerIds: readonly string[]
  eligiblePlayerIds: readonly string[]
  winnerIds: readonly string[]
  split: boolean
  oddChipCount: number
  oddChipRecipients: readonly string[]
  payouts: readonly PlayerPayout[]
}>

export type PayoutPlayerResult = Readonly<{
  playerId: string
  seat: number
  status: HandPlayerState['status']
  stack: number
  payout: number
  returnedExcess: number
}>

export type PayoutResult = Readonly<{
  players: readonly PayoutPlayerResult[]
  payouts: readonly PlayerPayout[]
  potPayouts: readonly PotPayout[]
  returnedExcess: readonly ReturnedExcess[]
  totalPayout: number
  totalReturnedExcess: number
}>

function assertSafeAmount(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer.`)
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return new Set(left).size === left.length && left.every(playerId => rightSet.has(playerId))
}

function assertBuiltPot(pot: BuiltPot, playerIds: ReadonlySet<string>, seenPotIds: Set<number>): void {
  assertSafeAmount(pot.id, `Pot ${pot.id} id`)
  if (seenPotIds.has(pot.id)) throw new Error(`Duplicate pot id ${pot.id}.`)
  seenPotIds.add(pot.id)
  assertSafeAmount(pot.amount, `Pot ${pot.id} amount`)
  assertSafeAmount(pot.cap, `Pot ${pot.id} cap`)

  if (new Set(pot.contributorPlayerIds).size !== pot.contributorPlayerIds.length) {
    throw new Error(`Pot ${pot.id} has duplicate contributors.`)
  }
  if (!pot.contributorPlayerIds.every(playerId => playerIds.has(playerId))) {
    throw new Error(`Pot ${pot.id} references an unknown contributor.`)
  }
  if (new Set(pot.eligiblePlayerIds).size !== pot.eligiblePlayerIds.length) {
    throw new Error(`Pot ${pot.id} has duplicate eligible players.`)
  }
  if (!pot.eligiblePlayerIds.every(playerId => pot.contributorPlayerIds.includes(playerId) && playerIds.has(playerId))) {
    throw new Error(`Pot ${pot.id} references an invalid eligible player.`)
  }
}

function assertShowdownPot(
  builtPot: BuiltPot,
  showdownPot: ResolvedPot,
  playersById: ReadonlyMap<string, PayoutPlayer>
): void {
  if (showdownPot.id !== builtPot.id || showdownPot.amount !== builtPot.amount) {
    throw new Error(`Showdown pot ${builtPot.id} does not match the built pot.`)
  }
  if (!sameIds(showdownPot.eligiblePlayerIds, builtPot.eligiblePlayerIds)) {
    throw new Error(`Showdown eligibility does not match pot ${builtPot.id}.`)
  }
  if (showdownPot.winners.length === 0 || new Set(showdownPot.winners).size !== showdownPot.winners.length) {
    throw new Error(`Showdown pot ${builtPot.id} must have unique winners.`)
  }
  if (showdownPot.tie !== (showdownPot.winners.length > 1)) {
    throw new Error(`Showdown tie flag is invalid for pot ${builtPot.id}.`)
  }
  for (const playerId of showdownPot.winners) {
    const player = playersById.get(playerId)
    if (!player || !builtPot.eligiblePlayerIds.includes(playerId)) {
      throw new Error(`Winner ${playerId} is not eligible for pot ${builtPot.id}.`)
    }
    if (player.status === 'FOLDED' || player.status === 'OUT') {
      throw new Error(`Folded player ${playerId} cannot receive a pot payout.`)
    }
  }
}

function excessMap(items: readonly ReturnedExcess[], playersById: ReadonlyMap<string, PayoutPlayer>): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of items) {
    if (!playersById.has(item.playerId)) throw new Error(`Returned excess references unknown player ${item.playerId}.`)
    assertSafeAmount(item.amount, `Returned excess for ${item.playerId}`)
    if (result.has(item.playerId)) throw new Error(`Returned excess is duplicated for ${item.playerId}.`)
    result.set(item.playerId, item.amount)
  }
  return result
}

function clockwiseSeatOrder(players: readonly PayoutPlayer[], dealerSeat: number): PayoutPlayer[] {
  const ordered = [...players].sort((left, right) => left.seat - right.seat)
  const dealerIndex = ordered.findIndex(player => player.seat === dealerSeat)
  if (dealerIndex < 0) throw new Error(`Dealer seat ${dealerSeat} is not present in the hand.`)
  return ordered.slice(dealerIndex + 1).concat(ordered.slice(0, dealerIndex + 1))
}

function distributePot(
  pot: BuiltPot,
  showdownPot: ResolvedPot,
  clockwisePlayers: readonly PayoutPlayer[]
): PotPayout {
  const winnerSet = new Set(showdownPot.winners)
  const orderedWinners = clockwisePlayers
    .filter(player => winnerSet.has(player.playerId))
    .map(player => player.playerId)
  if (orderedWinners.length !== showdownPot.winners.length) {
    throw new Error(`Could not establish seat order for pot ${pot.id} winners.`)
  }

  const baseAmount = Math.floor(pot.amount / orderedWinners.length)
  const oddChipCount = pot.amount % orderedWinners.length
  const oddChipRecipients = orderedWinners.slice(0, oddChipCount)
  const oddChipSet = new Set(oddChipRecipients)
  const payouts = orderedWinners.map(playerId => Object.freeze({
    playerId,
    amount: baseAmount + (oddChipSet.has(playerId) ? 1 : 0)
  }))

  return Object.freeze({
    potId: pot.id,
    amount: pot.amount,
    contributorPlayerIds: Object.freeze([...pot.contributorPlayerIds]),
    eligiblePlayerIds: Object.freeze([...pot.eligiblePlayerIds]),
    winnerIds: Object.freeze([...orderedWinners]),
    split: orderedWinners.length > 1,
    oddChipCount,
    oddChipRecipients: Object.freeze([...oddChipRecipients]),
    payouts: Object.freeze(payouts)
  })
}

/**
 * Resolves pot payouts into new stack values without mutating hand, pot, or
 * showdown state. Odd chips follow clockwise seat order after the dealer.
 */
export function resolvePayout(
  players: readonly PayoutPlayer[],
  builtPots: PotBuildResult,
  showdown: ShowdownResult,
  dealerSeat: number
): PayoutResult {
  if (!Array.isArray(players) || players.length === 0) throw new Error('Payout requires at least one player.')
  assertSafeAmount(dealerSeat, 'Dealer seat')
  if (!builtPots || !Array.isArray(builtPots.pots)) throw new Error('Payout requires a built pot result.')
  if (!showdown || !Array.isArray(showdown.pots)) throw new Error('Payout requires a showdown result.')

  const playersById = new Map<string, PayoutPlayer>()
  const seats = new Set<number>()
  for (const player of players) {
    if (typeof player.playerId !== 'string' || player.playerId.trim().length === 0) {
      throw new Error('Payout player id must be non-empty.')
    }
    if (playersById.has(player.playerId)) throw new Error('Payout player ids must be unique.')
    if (seats.has(player.seat)) throw new Error('Payout seats must be unique.')
    assertSafeAmount(player.seat, `Seat for ${player.playerId}`)
    assertSafeAmount(player.stack, `Stack for ${player.playerId}`, true)
    playersById.set(player.playerId, player)
    seats.add(player.seat)
  }

  const seenPotIds = new Set<number>()
  for (const pot of builtPots.pots) assertBuiltPot(pot, new Set(playersById.keys()), seenPotIds)
  if (builtPots.pots.length !== showdown.pots.length) throw new Error('Showdown pots do not match the built pots.')

  const showdownById = new Map<number, ResolvedPot>()
  for (const pot of showdown.pots) {
    if (showdownById.has(pot.id)) throw new Error(`Duplicate showdown pot id ${pot.id}.`)
    showdownById.set(pot.id, pot)
  }
  for (const builtPot of builtPots.pots) {
    const showdownPot = showdownById.get(builtPot.id)
    if (!showdownPot) throw new Error(`Showdown result is missing pot ${builtPot.id}.`)
    assertShowdownPot(builtPot, showdownPot, playersById)
  }

  const builtExcess = excessMap(builtPots.returnedExcess, playersById)
  const showdownExcess = excessMap(showdown.returnedExcess, playersById)
  if (builtExcess.size !== showdownExcess.size || [...builtExcess.entries()].some(([playerId, amount]) => showdownExcess.get(playerId) !== amount)) {
    throw new Error('Showdown returned excess does not match the built pots.')
  }
  assertSafeAmount(builtPots.totalContribution, 'Total contribution', true)
  const builtPotTotal = builtPots.pots.reduce((sum, pot) => sum + pot.amount, 0)
  const builtExcessTotal = [...builtExcess.values()].reduce((sum, amount) => sum + amount, 0)
  if (builtPotTotal + builtExcessTotal !== builtPots.totalContribution) {
    throw new Error('Built pots failed chip conservation.')
  }

  const clockwisePlayers = clockwiseSeatOrder(players, dealerSeat)
  const totalPayouts = new Map<string, number>()
  const potPayouts = builtPots.pots.map(builtPot => {
    const payout = distributePot(builtPot, showdownById.get(builtPot.id)!, clockwisePlayers)
    for (const item of payout.payouts) totalPayouts.set(item.playerId, (totalPayouts.get(item.playerId) ?? 0) + item.amount)
    return payout
  })

  const totalPayout = potPayouts.reduce((sum, pot) => sum + pot.payouts.reduce((potSum, item) => potSum + item.amount, 0), 0)
  const totalReturnedExcess = [...builtExcess.values()].reduce((sum, amount) => sum + amount, 0)
  const totalPotAmount = builtPotTotal
  if (totalPayout !== totalPotAmount) throw new Error('Payout failed pot chip conservation.')
  if (totalPayout + totalReturnedExcess !== totalPotAmount + totalReturnedExcess) {
    throw new Error('Payout failed returned-excess chip conservation.')
  }

  const orderedPlayers = [...players].sort((left, right) => left.seat - right.seat)
  const payouts = orderedPlayers.map(player => Object.freeze({ playerId: player.playerId, amount: totalPayouts.get(player.playerId) ?? 0 }))
  const returnedExcess = Object.freeze([...builtExcess.entries()].map(([playerId, amount]) => Object.freeze({ playerId, amount })))
  const resultPlayers = orderedPlayers.map(player => {
    const payout = totalPayouts.get(player.playerId) ?? 0
    const returned = builtExcess.get(player.playerId) ?? 0
    const stack = player.stack + payout + returned
    assertSafeAmount(stack, `Final stack for ${player.playerId}`, true)
    return Object.freeze({
      playerId: player.playerId,
      seat: player.seat,
      status: player.status,
      stack,
      payout,
      returnedExcess: returned
    })
  })

  return Object.freeze({
    players: Object.freeze(resultPlayers),
    payouts: Object.freeze(payouts),
    potPayouts: Object.freeze(potPayouts),
    returnedExcess,
    totalPayout,
    totalReturnedExcess
  })
}
