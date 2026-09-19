// House-edge math is kept separate from the service layer so it can be
// simulated and regression-tested without a database connection.
export const CRASH_DISTRIBUTION_FACTOR = 0.93

export function crashAtFromUnit(value: number) {
  const unit = Math.min(1 - Number.EPSILON, Math.max(0, value))
  return Math.min(1_000_000, Math.max(100, Math.floor((CRASH_DISTRIBUTION_FACTOR / (1 - unit)) * 100)))
}

export function expectedPayoutRate(targetHundredths: number, samples = 100_000) {
  let payout = 0
  for (let i = 0; i < samples; i++) {
    const unit = (i + 0.5) / samples
    if (crashAtFromUnit(unit) >= targetHundredths) payout += targetHundredths / 100
  }
  return payout / samples
}
