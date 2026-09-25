export interface TableRatingInput {
  won: boolean
  split: boolean
  folded: boolean
  hadAction: boolean
  hadRaise: boolean
  hadAllIn: boolean
}

export interface RatingChange {
  delta: number
  reason: string
}

export type RatingPotResult = Readonly<{
  amount: number
  contributorPlayerIds?: readonly string[]
  eligiblePlayerIds: readonly string[]
  foldedPlayerIds?: readonly string[]
  winnerIds: readonly string[]
}>

/** Pairwise, pot-weighted Elo deltas. Before the rating floor is applied, the table sums to zero. */
export function calculateZeroSumTableRatingDeltas(
  playerIds: readonly string[],
  ratings: ReadonlyMap<string, number>,
  pots: readonly RatingPotResult[],
  kFactor = 24
): ReadonlyMap<string, number> {
  const ids = [...new Set(playerIds)].filter(id => ratings.has(id)).sort()
  const changes = new Map(ids.map(id => [id, 0]))
  const totalWeight = pots.reduce((sum, pot) => sum + (Number.isFinite(pot.amount) && pot.amount > 0 ? pot.amount : 0), 0)
  if (ids.length < 2 || totalWeight <= 0 || !Number.isFinite(kFactor) || kFactor <= 0) return changes
  for (const pot of pots) {
    if (!Number.isFinite(pot.amount) || pot.amount <= 0) continue
    const eligible = new Set(pot.eligiblePlayerIds.filter(id => changes.has(id)))
    const folded = new Set((pot.foldedPlayerIds ?? []).filter(id => changes.has(id)))
    const contributors = [...new Set(pot.contributorPlayerIds ?? [...eligible, ...folded])]
      .filter(id => changes.has(id) && (eligible.has(id) || folded.has(id))).sort()
    if (contributors.length < 2) continue
    const winners = new Set(pot.winnerIds.filter(id => eligible.has(id)))
    if (winners.size === 0) continue
    const weight = pot.amount / totalWeight
    for (let left = 0; left < contributors.length; left += 1) {
      for (let right = left + 1; right < contributors.length; right += 1) {
        const a = contributors[left]!
        const b = contributors[right]!
        const scoreA = winners.has(a) ? winners.has(b) ? 0.5 : 1 : winners.has(b) ? 0 : 0.5
        const ratingA = ratings.get(a)!
        const ratingB = ratings.get(b)!
        const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
        const delta = kFactor * weight * (scoreA - expectedA)
        changes.set(a, changes.get(a)! + delta)
        changes.set(b, changes.get(b)! - delta)
      }
    }
  }
  const rounded = new Map([...changes].map(([id, delta]) => [id, Math.round(delta)]))
  let remainder = [...rounded.values()].reduce((sum, value) => sum + value, 0)
  const fractions = [...changes].map(([id, delta]) => ({ id, fraction: delta - Math.trunc(delta) }))
  while (remainder !== 0 && fractions.length) {
    fractions.sort((a, b) => remainder > 0 ? a.fraction - b.fraction || a.id.localeCompare(b.id) : b.fraction - a.fraction || a.id.localeCompare(b.id))
    for (const item of fractions) {
      if (remainder === 0) break
      rounded.set(item.id, rounded.get(item.id)! - Math.sign(remainder))
      remainder -= Math.sign(remainder)
    }
  }
  return rounded
}

export function calculateTableRatingChange(input: TableRatingInput): RatingChange {
  if (input.won) {
    const delta = Math.min(20, (input.split ? 7 : 12) + (input.hadRaise ? 2 : 0) + (input.hadAllIn ? 2 : 0))
    const reason = input.split
      ? 'Победа в делёжке'
      : input.hadAllIn
        ? 'Победа в all-in'
        : 'Победа за столом'
    return { delta, reason }
  }

  if (input.hadAllIn) return { delta: -10, reason: 'Проигрыш после all-in' }
  if (input.folded) return { delta: -3, reason: 'Сброс карт' }
  if (input.hadAction) return { delta: -6, reason: 'Проигрыш раздачи' }
  return { delta: -4, reason: 'Проигрыш раздачи' }
}

export function applyRatingChange(currentRating: number, delta: number): number {
  return Math.max(0, currentRating + delta)
}
