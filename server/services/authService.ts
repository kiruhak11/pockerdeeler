import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

function hashRaw(value: string): string {
  const pepper = process.env.ROOM_SECRET_PEPPER || 'dev-pepper'
  return createHash('sha256').update(`${value}:${pepper}`).digest('hex')
}

export function generateSecret(prefix: 'dealer' | 'player'): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

export function hashSecret(secret: string): string {
  return hashRaw(secret)
}

export function verifySecret(secret: string, hashedSecret: string): boolean {
  const incoming = hashRaw(secret)

  const left = Buffer.from(incoming)
  const right = Buffer.from(hashedSecret)

  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}
