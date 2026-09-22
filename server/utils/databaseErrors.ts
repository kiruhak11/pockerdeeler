import { Prisma } from '@prisma/client'

/** Prisma codes that indicate a temporary database/connectivity failure. */
const TRANSIENT_DATABASE_CODES = new Set([
  'P1001', // database server cannot be reached
  'P1002', // database server timed out
  'P1008', // operation timed out
  'P1017', // server closed the connection
  'P2024'  // connection pool timeout
])

function transientCode(value: unknown): boolean {
  return typeof value === 'string' && TRANSIENT_DATABASE_CODES.has(value)
}

/**
 * Recognizes only Prisma failures that mean the database is temporarily
 * unavailable. Validation, uniqueness, authorization, and programmer errors
 * deliberately do not match this predicate.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (error instanceof Prisma.PrismaClientInitializationError) return true
  if (error instanceof Prisma.PrismaClientKnownRequestError) return transientCode(error.code)

  const record = error as { code?: unknown; errorCode?: unknown; cause?: unknown }
  if (transientCode(record.code) || transientCode(record.errorCode)) return true
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /connection|connect|closed|timeout|timed out|unavailable|server has gone away/i.test(error.message)
  }
  return record.cause !== undefined && record.cause !== error && isDatabaseUnavailableError(record.cause)
}
