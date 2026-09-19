import { createHash, createHmac } from 'node:crypto'
export const MINES_COUNT = Array.from({ length: 24 }, (_, i) => i + 1) as number[]
export const MINES_COLUMNS = 5
export const MINES_ROWS = 5
export const MINES_MAX_PAYOUT = 1_000_000n
export const MINES_RTP_BPS = 9400
function combinations(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n
  let result = 1n
  for (let i = 1; i <= k; i++) result = result * BigInt(n - i + 1) / BigInt(i)
  return result
}
export function minesTerms(stake: bigint, mines: number, opened: number, limit: bigint) {
  if (!MINES_COUNT.includes(mines) || !Number.isInteger(opened) || opened < 0 || opened > 25 - mines) throw new Error('Invalid Mines parameters')
  if (opened === 0) return { payout: stake < limit ? stake : limit, multiplier: 1, multiplierBps: 10000, capped: false, safeChance: (25 - mines) / 25, riskPercent: mines / 25 }
  let numerator = 1n
  let denominator = 1n
  for (let i = 0; i < opened; i++) {
    numerator *= BigInt(25 - mines - i)
    denominator *= BigInt(25 - i)
  }
  // The curve pays 94% of the mathematically fair multiplier. This keeps the
  // first safe cell modest and makes every next safe cell increase smoothly.
  const multiplierBps = Number((BigInt(MINES_RTP_BPS) * denominator + numerator / 2n) / numerator)
  const raw = stake * BigInt(multiplierBps) / 10000n
  const payout = raw < limit ? raw : limit
  return { payout, multiplier: Number(payout * 10000n / stake) / 10000, multiplierBps, capped: raw >= limit, safeChance: (25 - mines - opened + 1) / (25 - opened + 1), riskPercent: opened < 25 - mines ? mines / (25 - opened) : 0 }
}
export function minesLimit(stake: bigint, mines: number = 24) {
  const safe = 25 - Math.max(1, Math.min(24, mines))
  let numerator = 1n
  let denominator = 1n
  for (let i = 0; i < safe; i++) {
    numerator *= BigInt(25 - mines - i)
    denominator *= BigInt(25 - i)
  }
  const maxMultiplierBps = Number((BigInt(MINES_RTP_BPS) * denominator + numerator / 2n) / numerator)
  const maximum = stake * BigInt(maxMultiplierBps) / 10000n
  return maximum < MINES_MAX_PAYOUT ? maximum : MINES_MAX_PAYOUT
}
export function legacyMinesTerms(stake: bigint, mines: number, opened: number, limit: bigint) {
  // Older releases exposed several presets (including 15 and 20 mines).
  // Keep the legacy combinatorics readable for every value that could have
  // been stored before the current 1..24 rules were introduced.
  if (!Number.isInteger(mines) || mines < 1 || mines > 24 || !Number.isInteger(opened) || opened < 0 || opened > 25 - mines) throw new Error('Invalid legacy Mines parameters')
  const numerator = opened ? combinations(25, opened) * 94n : 1n
  const denominator = opened ? combinations(25 - mines, opened) * 100n : 1n
  const raw = stake * numerator / denominator
  const payout = raw < limit ? raw : limit
  return { payout, multiplier: Number((raw >= limit ? limit * 10000n / stake : numerator * 10000n / denominator)) / 10000, capped: raw >= limit, riskPercent: mines / (25 - opened) }
}
export function legacyMinesField(serverSeed: string, clientSeed: string, nonce: number, mines: number) {
  return Array.from({ length: 25 }, (_, cell) => ({ cell, hash: createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cell}`).digest('hex') }))
    .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.cell - b.cell).slice(0, mines).map(item => item.cell).sort((a, b) => a - b)
}
export function seedHash(seed: string) { return createHash('sha256').update(seed).digest('hex') }
export function minesField(serverSeed: string, clientSeed: string, nonce: number, mines: number) {
  if (!MINES_COUNT.includes(mines)) throw new Error('Invalid Mines count')
  return Array.from({ length: 25 }, (_, cell) => ({ cell, hash: createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cell}`).digest('hex') }))
    .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.cell - b.cell).slice(0, mines).map(item => item.cell).sort((a, b) => a - b)
}
