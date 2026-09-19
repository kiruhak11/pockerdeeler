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
