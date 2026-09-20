import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { callStatus, normalizePhone } from '../server/services/phoneService'

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3106'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
assert.ok(process.env.DATABASE_URL?.includes(':55439/'), 'Isolated database only')
const db = new PrismaClient(), users: string[] = [], verifications: string[] = [], rooms: string[] = [], audits: string[] = []
const password = 'Platform-test-password-2026'
class Browser {
  cookies = new Map<string, string>()
  async request(path: string, body?: unknown, expected = 200, origin = base) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const index = pair!.indexOf('='); this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1)) }
    const value = await response.json()
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`)
    return value
  }
}
async function fixture(phone: string, role = 'USER') {
  const browser = new Browser()
  const { user, token } = await browser.request('/api/auth/register', { username: `platform_${randomUUID().slice(0, 12)}`, password })
  users.push(user.id)
  await db.user.update({ where: { id: user.id }, data: { phone, phoneVerifiedAt: new Date(), role } })
  browser.cookies.set('poker_account', token)
  return { browser, user }
}
after(async () => {
  await db.room.deleteMany({ where: { code: { in: rooms } } })
  await db.adminAudit.deleteMany({ where: { OR: [{ actorId: { in: users } }, { requestId: { in: audits } }] } })
  await db.phoneVerification.deleteMany({ where: { id: { in: verifications } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await db.$disconnect()
})

test('Russian normalization and API success are distinct from verified telephone', () => {
  assert.equal(normalizePhone('8 (999) 123-45-67'), '+79991234567')
  assert.equal(normalizePhone('+7 999 1234567'), '+79991234567')
  assert.throws(() => normalizePhone('+1 555 1234567'))
  assert.equal(callStatus({ status_code: 100 }), 'pending')
  assert.equal(callStatus({ status_code: 100, check_status: 400 }), 'pending')
  assert.equal(callStatus({ status_code: '100', check_status: '401' }), 'verified')
  assert.equal(callStatus({ status_code: 100, check_status: 402 }), 'expired')
  assert.equal(callStatus({ status_code: 500, check_status: 401 }), 'error')
})

test('phone challenge is browser bound, persistent, one-use and creates opaque HttpOnly session', async () => {
  const b = new Browser(), intruder = new Browser(), requestId = randomUUID()
  // Establish browser identity before intentionally racing two starts.
  b.cookies.set('poker_phone_browser', randomBytes(32).toString('base64url'))
  const payload = { phone: '+7 999 321 45 67', purpose: 'register', requestId }
  const [a, retry] = await Promise.all([b.request('/api/auth/phone/start', payload), b.request('/api/auth/phone/start', payload)])
  verifications.push(a.id)
  assert.equal(a.id, retry.id)
  assert.equal(await db.phoneVerification.count({ where: { requestId } }), 1)
  await intruder.request('/api/auth/phone/status', { id: a.id }, 403)
  await b.request('/api/auth/phone/complete', { id: a.id, username: 'forged', password }, 403)
  const verified = await b.request('/api/auth/phone/status', { id: a.id })
  assert.equal(verified.status, 'verified')
  const signedIn = await b.request('/api/auth/phone/complete', {
    id: a.id,
    username: `phone_${randomUUID().slice(0, 8)}`,
    password,
    ageConfirmed: true,
    termsAccepted: true,
    privacyAcknowledged: true,
    personalDataConsent: true
  })
  users.push(signedIn.user.id)
  assert.equal(signedIn.token, 'cookie-session')
  assert.equal(signedIn.user.phone, '+79993214567')
  assert.equal(signedIn.user.balance, 5000)
  assert.ok(b.cookies.get('poker_account'))
  assert.equal((await b.request('/api/auth/session')).user.id, signedIn.user.id)
  await b.request('/api/auth/phone/complete', { id: a.id, username: 'replay', password }, 403)
  await b.request('/api/auth/logout', {}, 403, 'https://attacker.invalid')
  await b.request('/api/auth/logout', {})
  await b.request('/api/auth/session', undefined, 401)
})

test('reward duration, foreign attempt, parallel completion, cooldown and ledger invariants', async () => {
  const a = await fixture('+79993214568'), b = await fixture('+79993214569')
  const requestId = randomUUID()
  const [s1, s2] = await Promise.all([a.browser.request('/api/rewards/start', { requestId }), a.browser.request('/api/rewards/start', { requestId: randomUUID() })])
  assert.equal(s1.attempt.id, s2.attempt.id)
  const id = s1.attempt.id
  await a.browser.request('/api/rewards/complete', { id }, 409)
  await b.browser.request('/api/rewards/complete', { id }, 404)
  // Clock travel is fixture-only SQL, never an application endpoint.
  await db.rewardSession.update({ where: { id }, data: { readyAt: new Date(Date.now() - 1000) } })
  const complete = await Promise.all([a.browser.request('/api/rewards/complete', { id }), a.browser.request('/api/rewards/complete', { id })])
  assert.equal(complete[0].user.balance, 10000)
  assert.equal(complete[1].user.balance, 10000)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `reward:${id}` } }), 1)
  await a.browser.request('/api/rewards/start', { requestId: randomUUID() }, 409)
  assert.equal((await a.browser.request('/api/rewards/complete', { id })).user.balance, 10000)
  await a.browser.request('/api/auth/daily-bonus', { token: 'cookie-session' }, 410)
  await a.browser.request('/api/auth/reset-balance', { token: 'cookie-session' }, 410)
})

test('cancelled and expired promo sessions do not grant points; active players are ineligible', async () => {
  const a = await fixture('+79993214570')
  let s = await a.browser.request('/api/rewards/start', { requestId: randomUUID() })
  await a.browser.request('/api/rewards/cancel', { id: s.attempt.id })
  await a.browser.request('/api/rewards/complete', { id: s.attempt.id }, 409)
  s = await a.browser.request('/api/rewards/start', { requestId: randomUUID() })
  await db.rewardSession.update({ where: { id: s.attempt.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  await a.browser.request('/api/rewards/complete', { id: s.attempt.id }, 409)
  const r = await a.browser.request('/api/rooms/create', { name: 'Reward test', startingStack: 100, smallBlind: 5, bigBlind: 10, maxPlayers: 4, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true })
  rooms.push(r.roomCode)
  await a.browser.request(`/api/rooms/${r.roomCode}/join`, { name: 'account', authToken: 'cookie-session', buyInAmount: 100 })
  await a.browser.request(`/api/rooms/${r.roomCode}/join`, { name: 'guest' })
  await a.browser.request(`/api/rooms/${r.roomCode}/start-game`, { dealerSecret: r.dealerSecret })
  assert.equal((await a.browser.request('/api/rewards/state')).available, false)
  await a.browser.request('/api/rewards/start', { requestId: randomUUID() }, 409)
})

test('admin requires verified role; financial mutations are audited, idempotent and version-checked', async () => {
  const normal = await fixture('+79993214571'), admin = await fixture('+79993214572', 'SUPERADMIN'), guest = new Browser()
  await guest.request('/api/admin/overview', undefined, 401)
  await normal.browser.request('/api/admin/overview', undefined, 403)
  await admin.browser.request('/api/admin/overview')
  const body = { action: 'credit', amount: 500, expectedBalance: 5000, reason: 'Integration correction', requestId: randomUUID(), password }
  audits.push(body.requestId)
  await admin.browser.request(`/api/admin/users/${normal.user.id}`, body)
  await admin.browser.request(`/api/admin/users/${normal.user.id}`, body)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: normal.user.id } })).balance, 5500n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: `admin:${body.requestId}` } }), 1)
  await admin.browser.request(`/api/admin/users/${normal.user.id}`, { ...body, requestId: randomUUID() }, 409)
  await admin.browser.request(`/api/admin/users/${normal.user.id}`, { ...body, expectedBalance: 5500, password: 'wrong', requestId: randomUUID() }, 403)
  await admin.browser.request(`/api/admin/users/${admin.user.id}`, { action: 'block', reason: 'Last superadmin protection', requestId: randomUUID(), password }, 409)
  await db.user.update({ where: { id: admin.user.id }, data: { role: 'USER' } })
  await admin.browser.request('/api/admin/overview', undefined, 403)
})
