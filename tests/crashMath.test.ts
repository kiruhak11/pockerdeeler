import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CRASH_DISTRIBUTION_FACTOR, crashAtFromUnit, expectedPayoutRate } from '../server/utils/crashMath'

test('Rocket has negative expected value on a long fixed-target run', () => {
  const expected = expectedPayoutRate(200, 100_000)
  assert.ok(expected < 1, `expected payout rate ${expected} must stay below stake`)
  assert.ok(expected <= CRASH_DISTRIBUTION_FACTOR + 0.002)
})

test('Rocket payout curve stays bounded and keeps 1.01x auto-cashout negative EV', () => {
  assert.ok(expectedPayoutRate(101, 100_000) < 1)
  assert.ok(expectedPayoutRate(1000, 100_000) < 1)
})

test('Rocket stays negative across a long bounded Martingale-style simulation', () => {
  let state = 0x12345678
  let bankroll = 0
  let stake = 100
  for (let i = 0; i < 200_000; i += 1) {
    state = (1664525 * state + 1013904223) >>> 0
    const unit = (state + 0.5) / 0x1_0000_0000
    const won = crashAtFromUnit(unit) >= 200
    bankroll -= stake
    if (won) {
      bankroll += stake * 2
      stake = 100
    } else {
      stake = stake >= 1_600 ? 100 : stake * 2
    }
  }
  assert.ok(bankroll < 0, `bounded progression must not produce positive EV: ${bankroll}`)
})
