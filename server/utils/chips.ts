import { createError } from 'h3'

export const MAX_CHIP_AMOUNT = 2_000_000_000

export function toChipNumber(value: bigint | number): number {
  const amount = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(amount)) {
    throw createError({ statusCode: 500, statusMessage: 'Сумма фишек вышла за безопасный диапазон' })
  }
  return amount
}

export function toChipBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CHIP_AMOUNT) {
    throw createError({ statusCode: 400, statusMessage: 'Некорректная сумма фишек' })
  }
  return BigInt(value)
}
