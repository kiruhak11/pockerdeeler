import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { minesStakeSchema, minesStartInputSchema } from '../server/utils/minesValidation'
import { minesAvailableBankReserve, minesBackedPayoutLimit, minesLimit } from '../server/utils/minesMath'

test('Mines accepts any positive safe-integer stake without a fixed upper cap', () => {
  for (const stake of [1, 9_999, 10_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(minesStakeSchema.safeParse(stake).success, true, `stake ${stake}`)
  }
  assert.equal(minesStartInputSchema.safeParse({
    stake: 12_347,
    mines: 5,
    clientSeed: 'client-seed',
    commitmentId: '2b7a7e2e-6d7f-4db5-ae50-bbe9e5b410af',
    idempotencyKey: 'mines-start-idempotency'
  }).success, true)
})

test('Mines stake schema rejects zero, negative, fractional, non-finite and malformed values', () => {
  for (const stake of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.equal(minesStakeSchema.safeParse(stake).success, false, `stake ${String(stake)}`)
  }
})

test('Mines allows a small stake when the bank can cover a backed session cap', () => {
  const stake = 10n
  const theoretical = minesLimit(stake, 5)
  assert.equal(theoretical, 499_422n)
  assert.equal(minesBackedPayoutLimit(theoretical, 14_900n, stake), 14_900n)
  assert.equal(minesBackedPayoutLimit(1_000n, 2_000n, stake), 1_000n)
  assert.equal(minesBackedPayoutLimit(theoretical, 9n, stake), null)
})

test('Mines reserves payout from the shared game bank, independent of the admin wallet', () => {
  const stake = 10n
  const dailyBank = 1_999_986n
  const available = minesAvailableBankReserve(dailyBank, 0n)
  assert.equal(minesBackedPayoutLimit(minesLimit(stake, 5), available, stake), minesLimit(stake, 5))
  assert.equal(minesAvailableBankReserve(dailyBank, 1_500_000n), 499_986n)
  assert.equal(minesAvailableBankReserve(dailyBank, 2_000_000n), 0n)
})

test('Mines UI max follows the current wallet and full-balance button selects it', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/minigames/MinesGame.vue'), 'utf8')
  assert.match(source, /const walletBalance = computed\(\(\) => Number\(account\.user\?\.balance \?\? 0\)\)/)
  assert.match(source, /:max="walletBalance"/)
  assert.match(source, /@click="stake=walletBalance"/)
  assert.doesNotMatch(source, /max="100000"|100_000|10–100 000/)
})
