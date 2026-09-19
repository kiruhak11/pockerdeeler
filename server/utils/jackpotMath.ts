import { randomBytes } from 'node:crypto'

export const JACKPOT_SHARES = [50, 30, 20] as const
export function splitJackpot(pot: bigint) {
  if (pot < 0n) throw new Error('Negative jackpot')
  const second = pot * 30n / 100n
  const third = pot * 20n / 100n
  return [pot - second - third, second, third]
}

export function splitJackpotTenths(potTenths: bigint) {
  if (potTenths < 0n) throw new Error('Negative jackpot')
  const second = potTenths * 30n / 100n
  const third = potTenths * 20n / 100n
  return [potTenths - second - third, second, third]
}

// Rejection sampling keeps every ticket equally likely, including large pots.
export function randomTicket(total: bigint): bigint {
  if (total <= 0n) throw new Error('Empty ticket pool')
  const bytes = Math.ceil(total.toString(2).length / 8)
  const range = 1n << BigInt(bytes * 8)
  const limit = range - range % total
  let value: bigint
  do { value = BigInt('0x' + randomBytes(bytes).toString('hex')) } while (value >= limit)
  return value % total
}

export function drawWinners<T extends { weight: bigint }>(participants: T[], pick = randomTicket): T[] {
  const pool = participants.filter(p => p.weight > 0n).slice()
  const winners: T[] = []
  while (pool.length && winners.length < 3) {
    let ticket = pick(pool.reduce((sum, p) => sum + p.weight, 0n))
    const index = pool.findIndex(p => { ticket -= p.weight; return ticket < 0n })
    if (index < 0) throw new Error('Invalid winning ticket')
    winners.push(pool.splice(index, 1)[0]!)
  }
  return winners
}
