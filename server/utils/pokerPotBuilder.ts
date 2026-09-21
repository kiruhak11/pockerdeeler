import type { HandPlayerState } from './pokerHandState'

export type PotBuildPlayer = Pick<HandPlayerState, 'playerId' | 'contribution' | 'status'>

export type BuiltPot = Readonly<{
  id: number
  amount: number
  cap: number
  contributorPlayerIds: readonly string[]
  eligiblePlayerIds: readonly string[]
}>

export type ReturnedExcess = Readonly<{
  playerId: string
  amount: number
}>

export type PotBuildResult = Readonly<{
  pots: readonly BuiltPot[]
  returnedExcess: readonly ReturnedExcess[]
  totalContribution: number
}>

function assertPlayer(player: PotBuildPlayer, seen: Set<string>): void {
  if (typeof player.playerId !== 'string' || player.playerId.trim().length === 0) {
    throw new Error('Pot player id must be a non-empty string.')
  }
  if (seen.has(player.playerId)) throw new Error('Pot player ids must be unique.')
  seen.add(player.playerId)
  if (!Number.isSafeInteger(player.contribution) || player.contribution < 0) {
    throw new Error(`Contribution for ${player.playerId} must be a non-negative safe integer.`)
  }
}

function isEligible(status: HandPlayerState['status']): boolean {
  return status !== 'FOLDED' && status !== 'OUT'
}

/**
 * Builds contested main and side pots from server-authoritative total
 * contributions. A layer with only one contributor is returned as unmatched
 * excess instead of being exposed as a pot that somebody else could win.
 */
export function buildPots(players: readonly PotBuildPlayer[]): PotBuildResult {
  const seen = new Set<string>()
  for (const player of players) assertPlayer(player, seen)

  const committed = players.filter(player => player.contribution > 0)
  const levels = [...new Set(committed.map(player => player.contribution))].sort((left, right) => left - right)
  const pots: BuiltPot[] = []
  const returnedByPlayer = new Map<string, number>()
  let previousLevel = 0

  for (const cap of levels) {
    const contributors = committed.filter(player => player.contribution >= cap)
    const layerSize = cap - previousLevel
    if (layerSize <= 0 || contributors.length === 0) continue
    const amount = layerSize * contributors.length
    if (!Number.isSafeInteger(amount)) throw new Error('Pot amount exceeds the safe integer range.')

    if (contributors.length === 1) {
      const playerId = contributors[0]!.playerId
      returnedByPlayer.set(playerId, (returnedByPlayer.get(playerId) ?? 0) + amount)
    } else {
      pots.push(Object.freeze({
        id: pots.length + 1,
        amount,
        cap,
        contributorPlayerIds: Object.freeze(contributors.map(player => player.playerId)),
        eligiblePlayerIds: Object.freeze(contributors.filter(player => isEligible(player.status)).map(player => player.playerId))
      }))
    }
    previousLevel = cap
  }

  const returnedExcess = Object.freeze([...returnedByPlayer.entries()].map(([playerId, amount]) => Object.freeze({ playerId, amount })))
  const totalContribution = players.reduce((sum, player) => sum + player.contribution, 0)
  if (!Number.isSafeInteger(totalContribution)) throw new Error('Total contribution exceeds the safe integer range.')
  const contestedTotal = pots.reduce((sum, pot) => sum + pot.amount, 0)
  const returnedTotal = returnedExcess.reduce((sum, item) => sum + item.amount, 0)
  if (contestedTotal + returnedTotal !== totalContribution) {
    throw new Error('Pot construction failed chip conservation.')
  }

  return Object.freeze({
    pots: Object.freeze(pots),
    returnedExcess,
    totalContribution
  })
}
