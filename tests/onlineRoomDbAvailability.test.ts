import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import type { H3Event } from 'h3'
import { prisma } from '../server/db/client'
import { requireOnlineRoomUser } from '../server/utils/onlineRoomApiAuth'
import { createAuthenticatedOnlineRoom, resolveOnlineRoomCode } from '../server/services/onlineRoomApiService'
import { isDatabaseUnavailableError } from '../server/utils/databaseErrors'
import { throwOnlineRoomApiError } from '../server/utils/onlineRoomApiErrors'

function known(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('database failure', { code, clientVersion: '6.7.0' })
}

function initialization(): Prisma.PrismaClientInitializationError {
  return new Prisma.PrismaClientInitializationError('database initialization failed', '6.7.0', 'P1001')
}

function thrownStatus(error: unknown): { statusCode?: number; statusMessage?: string; message?: string } {
  try {
    throwOnlineRoomApiError(error)
  } catch (mapped) {
    return mapped as { statusCode?: number; statusMessage?: string; message?: string }
  }
  throw new Error('Expected an error.')
}

function authEvent(): H3Event {
  return {
    node: { req: { headers: { cookie: `poker_account=${'a'.repeat(32)}` } } },
    headers: new Headers(),
    path: '/api/online/rooms'
  } as unknown as H3Event
}

test('only transient Prisma connectivity failures are database unavailable', () => {
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024']) {
    assert.equal(isDatabaseUnavailableError(known(code)), true, code)
  }
  assert.equal(isDatabaseUnavailableError(initialization()), true)
  assert.equal(isDatabaseUnavailableError(known('P2002')), false)
  assert.equal(isDatabaseUnavailableError(known('P2025')), false)
  assert.equal(isDatabaseUnavailableError(new Prisma.PrismaClientValidationError('invalid query', { clientVersion: '6.7.0' })), false)
  assert.equal(isDatabaseUnavailableError(new Error('programmer failure')), false)
})

test('database outage maps to a minimal HTTP 503 without Prisma internals', () => {
  const mapped = thrownStatus(known('P1001'))
  assert.equal(mapped.statusCode, 503)
  assert.equal(mapped.statusMessage, 'Online room service is temporarily unavailable.')
  assert.equal(JSON.stringify(mapped).includes('database failure'), false)
  assert.equal(JSON.stringify(mapped).includes('P1001'), false)
})

test('database initialization outage maps to HTTP 503', () => {
  assert.equal(thrownStatus(initialization()).statusCode, 503)
})

test('authenticated session lookup outage is HTTP 503, not 401', async () => {
  const delegate = prisma.accountSession as unknown as { findUnique: (...args: unknown[]) => Promise<unknown> }
  const original = delegate.findUnique
  delegate.findUnique = async () => { throw known('P1001') }
  try {
    await assert.rejects(requireOnlineRoomUser(authEvent()), (error: unknown) => {
      const candidate = error as { statusCode?: number; statusMessage?: string }
      return candidate.statusCode === 503 && candidate.statusMessage === 'Online room service is temporarily unavailable.'
    })
  } finally {
    delegate.findUnique = original
  }
})

test('online room create outage during persistent transaction is HTTP 503', async () => {
  const client = prisma as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> }
  const original = client.$transaction
  client.$transaction = async () => { throw known('P1001') }
  try {
    await assert.rejects(createAuthenticatedOnlineRoom(`db-down-${Date.now()}`), (error: unknown) => {
      return error instanceof Error && 'statusCode' in error && (error as { statusCode?: number }).statusCode === 503
    })
  } finally {
    client.$transaction = original
  }
})

test('resolver database outage remains HTTP 503 at the API boundary', async () => {
  const delegate = prisma.roomCodeRegistry as unknown as { findUnique: (...args: unknown[]) => Promise<unknown> }
  const original = delegate.findUnique
  delegate.findUnique = async () => { throw known('P1017') }
  try {
    await assert.rejects(resolveOnlineRoomCode('AB2345'), (error: unknown) => {
      const mapped = thrownStatus(error)
      return mapped.statusCode === 503
    })
  } finally {
    delegate.findUnique = original
  }
})

test('validation, authorization, and business conflicts keep their existing semantics', () => {
  const badRequest = thrownStatus({ statusCode: 400, statusMessage: 'Invalid room settings' })
  assert.equal(badRequest.statusCode, 400)
  const unauthorized = thrownStatus({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(thrownStatus(known('P2002')).statusCode, 500)
})

test('unexpected errors remain HTTP 500 and do not expose internals', () => {
  const mapped = thrownStatus(new Error('secret database URL and programmer detail'))
  assert.equal(mapped.statusCode, 500)
  assert.equal(mapped.statusMessage, 'Internal server error.')
  assert.equal(JSON.stringify(mapped).includes('secret database URL'), false)
})
