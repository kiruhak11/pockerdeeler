import test from 'node:test'
import assert from 'node:assert/strict'
import { PREMIUM_FEATURES, PREMIUM_PLANS, premiumExpiresAt } from '../server/services/premiumService'
import { BASE_REWARD_AMOUNT, ELITE_REWARD_AMOUNT, rewardAmountForPlan } from '../server/services/rewardService'

test('Premium catalogue has the requested prices and 30-day duration', () => {
  assert.deepEqual(PREMIUM_PLANS.map(({ plan, priceRub, durationDays }) => ({ plan, priceRub, durationDays })), [
    { plan: 'LITE', priceRub: 149, durationDays: 30 },
    { plan: 'PRO', priceRub: 299, durationDays: 30 },
    { plan: 'ELITE', priceRub: 499, durationDays: 30 }
  ])
  const start = new Date('2026-09-19T12:00:00.000Z')
  assert.equal(premiumExpiresAt(start).toISOString(), '2026-10-19T12:00:00.000Z')
})

test('Premium plans inherit capabilities without game or rating advantages', () => {
  for (const feature of PREMIUM_FEATURES.LITE) assert.ok(PREMIUM_FEATURES.PRO.includes(feature))
  for (const feature of PREMIUM_FEATURES.PRO) assert.ok(PREMIUM_FEATURES.ELITE.includes(feature))
  const all = Object.values(PREMIUM_FEATURES).flat().join(' ')
  for (const forbidden of ['WIN', 'PAYOUT', 'ODDS', 'ROCKET', 'MINES', 'POKER_BONUS', 'RATING_BONUS']) assert.equal(all.includes(forbidden), false)
})

test('only Elite exposes the existing-rating Premium leaderboard filter', () => {
  assert.equal(PREMIUM_FEATURES.LITE.includes('LEADERBOARD_PREMIUM_FILTER'), false)
  assert.equal(PREMIUM_FEATURES.PRO.includes('LEADERBOARD_PREMIUM_FILTER'), false)
  assert.equal(PREMIUM_FEATURES.ELITE.includes('LEADERBOARD_PREMIUM_FILTER'), true)
})

test('chat and combinations are Lite features, while the Elite reward amount is server-defined', () => {
  assert.equal(PREMIUM_FEATURES.LITE.includes('ROOM_CHAT'), true)
  assert.equal(PREMIUM_FEATURES.LITE.includes('POKER_HANDS_GUIDE'), true)
  assert.equal(rewardAmountForPlan(null, BASE_REWARD_AMOUNT), 10000)
  assert.equal(rewardAmountForPlan('LITE', BASE_REWARD_AMOUNT), 10000)
  assert.equal(rewardAmountForPlan('PRO', BASE_REWARD_AMOUNT), 10000)
  assert.equal(rewardAmountForPlan('ELITE', BASE_REWARD_AMOUNT), ELITE_REWARD_AMOUNT)
  assert.equal(rewardAmountForPlan('ELITE', 99999), ELITE_REWARD_AMOUNT)
})
