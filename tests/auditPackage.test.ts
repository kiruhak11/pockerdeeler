import test from 'node:test'
import assert from 'node:assert/strict'
import { BASE_REWARD_AMOUNT, ELITE_REWARD_AMOUNT, rewardAmountForPlan } from '../server/services/rewardService'
import { normalizeUserTelegramSettings, USER_TELEGRAM_CATEGORIES } from '../server/services/notificationService'
import { normalizeAdminTelegramSettings, ADMIN_TELEGRAM_CATEGORIES } from '../server/services/adminTelegramNotificationService'

test('bonus amounts are fixed server rules', () => {
  assert.equal(BASE_REWARD_AMOUNT, 10_000)
  assert.equal(ELITE_REWARD_AMOUNT, 15_000)
  assert.equal(rewardAmountForPlan(null, 1), 10_000)
  assert.equal(rewardAmountForPlan('LITE', 999_999), 10_000)
  assert.equal(rewardAmountForPlan('PRO', 999_999), 10_000)
  assert.equal(rewardAmountForPlan('ELITE', 1), 15_000)
})

test('Telegram preferences are server-normalized and admin-only categories are separate', () => {
  assert.deepEqual(normalizeUserTelegramSettings({ friends: false, unknown: true }), { purchases: true, premium: true, friends: false, games: true, achievements: true, seasons: true, adminChanges: true })
  assert.deepEqual(ADMIN_TELEGRAM_CATEGORIES, ['payments', 'users', 'games', 'premium', 'achievements'])
  assert.deepEqual(USER_TELEGRAM_CATEGORIES, ['purchases', 'premium', 'friends', 'games', 'achievements', 'seasons', 'adminChanges'])
  assert.equal(normalizeAdminTelegramSettings({ categories: { users: false } }).categories.users, false)
})
