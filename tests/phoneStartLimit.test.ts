import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp, eventHandler, readBody, toNodeListener } from 'h3'
import Redis from 'ioredis'
import { completePhoneVerification, pollPhoneVerification, startPhoneVerification } from '../server/services/phoneService'
import { getUserProfile, sessionHash } from '../server/services/userAccountService'
import { prisma } from '../server/db/client'
import { accountCookie, clearAccountCookie, COOKIE_MARKER, saveAccountCookie } from '../server/utils/accountCookie'
import { checkPhoneStartQuota, closePhoneStartLimitStore, consumePhoneStartCounters, PHONE_START_LIMITS, resolvePhoneSourceIp } from '../server/utils/phoneStartLimit'

test('phone source IP ignores client forwarded headers without an explicitly trusted peer', () => {
  assert.equal(resolvePhoneSourceIp('::ffff:127.0.0.1', '198.51.100.42', ''), '127.0.0.1')
  assert.equal(resolvePhoneSourceIp('192.0.2.10', '198.51.100.42', '192.0.2.10'), '198.51.100.42')
  assert.equal(resolvePhoneSourceIp('192.0.2.11', '198.51.100.42', '192.0.2.10'), '192.0.2.11')
  assert.throws(() => resolvePhoneSourceIp('192.0.2.10', '198.51.100.42, 203.0.113.1', '192.0.2.10'), error => (error as { statusCode?: number }).statusCode === 503)
  assert.throws(() => resolvePhoneSourceIp('192.0.2.10', undefined, '192.0.2.10'), error => (error as { statusCode?: number }).statusCode === 503)
})

test('shared counter failure blocks phone start', async () => {
  await assert.rejects(
    checkPhoneStartQuota('+79990000000', '127.0.0.1', async () => { throw new Error('Redis unavailable') }),
    error => (error as { statusCode?: number }).statusCode === 503
  )
})

test('missing Redis configuration fails closed', async () => {
  const previous = process.env.REDIS_URL
  delete process.env.REDIS_URL
  try {
    await assert.rejects(consumePhoneStartCounters('+79990000000', '127.0.0.1'), error => (error as { statusCode?: number }).statusCode === 503)
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previous
  }
})

test('production auth cookie is secure, host-only, HttpOnly and usable behind an HTTPS proxy', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const app = createApp()
  app.use('/cookie', eventHandler(event => {
    saveAccountCookie(event, 'opaque-session-token-for-cookie-test')
    return { ok: true }
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/cookie`, {
      headers: { host: 'pocker.example', 'x-forwarded-proto': 'https' }
    })
    const cookie = response.headers.get('set-cookie') || ''
    assert.equal(response.status, 200)
    assert.match(cookie, /^poker_account=opaque-session-token-for-cookie-test;/)
    assert.match(cookie, /(?:^|; )Secure(?:;|$)/)
    assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/)
    assert.match(cookie, /(?:^|; )SameSite=Lax(?:;|$)/)
    assert.match(cookie, /(?:^|; )Path=\/(?:;|$)/)
    assert.match(cookie, /Max-Age=2592000/)
    assert.doesNotMatch(cookie, /Domain=/i)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})

const testRedisUrl = process.env.PHONE_TEST_REDIS_URL
const testDbUrl = process.env.DATABASE_URL
const isolated = Boolean(testRedisUrl && /^redis:\/\/127\.0\.0\.1:\d+\/\d+$/.test(testRedisUrl) && testDbUrl?.includes('_test'))

test('phone start uses shared limits without changing the active verification flow', { skip: !isolated }, async t => {
  const previousRedisUrl = process.env.REDIS_URL
  const previousSmsId = process.env.SMS_RU_API_ID
  const previousSmsMode = process.env.SMS_RU_MODE
  const previousTrustedProxies = process.env.PHONE_TRUSTED_PROXY_IPS
  process.env.REDIS_URL = testRedisUrl
  process.env.SMS_RU_API_ID = 'isolated-test-key'
  process.env.SMS_RU_MODE = 'production'
  process.env.PHONE_TRUSTED_PROXY_IPS = ''
  const redis = new Redis(testRedisUrl!)
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  let providerStatusCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://sms.ru/callcheck/add') {
      providerCalls += 1
      return new Response(JSON.stringify({ status_code: 100, check_id: randomUUID(), call_phone: '78005553535' }), { status: 200 })
    }
    if (url === 'https://sms.ru/callcheck/status') {
      providerStatusCalls += 1
      return new Response(JSON.stringify({ status_code: 100, check_status: '401' }), { status: 200 })
    }
    return originalFetch(input, init)
  }

  const app = createApp()
  app.use('/phone/start', eventHandler(async event => startPhoneVerification(event, await readBody(event))))
  app.use('/phone/status', eventHandler(async event => pollPhoneVerification(event, (await readBody(event)).id)))
  app.use('/phone/complete', eventHandler(async event => {
    const input = await readBody(event)
    const result = await completePhoneVerification(event, { ...input, legal: {
      ageConfirmed: input.ageConfirmed,
      termsAccepted: input.termsAccepted,
      privacyAcknowledged: input.privacyAcknowledged,
      personalDataConsent: input.personalDataConsent
    } })
    saveAccountCookie(event, result.token)
    return { user: result.user, token: COOKIE_MARKER }
  }))
  app.use('/auth/session', eventHandler(async event => ({ user: await getUserProfile(accountCookie(event)) })))
  app.use('/auth/logout', eventHandler(async event => {
    const token = accountCookie(event)
    if (token) await prisma.accountSession.updateMany({ where: { tokenHash: sessionHash(token) }, data: { revokedAt: new Date() } })
    clearAccountCookie(event)
    return { success: true }
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  const cookie = () => `poker_phone_browser=${randomBytes(32).toString('base64url')}`
  async function post(path: string, body: Record<string, unknown>, browserCookie = cookie(), headers: Record<string, string> = {}) {
    const response = await originalFetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: browserCookie, ...headers }, body: JSON.stringify(body)
    })
    return { response, data: await response.json() as Record<string, any> }
  }
  async function get(path: string, requestCookie = '') {
    const response = await originalFetch(`${base}${path}`, { headers: { origin: base, ...(requestCookie ? { cookie: requestCookie } : {}) } })
    return { response, data: await response.json() as Record<string, any> }
  }

  try {
    await t.test('normal start, active request reuse, status and registration remain available', async () => {
      await redis.flushdb()
      const browser = cookie(), phone = `+7999${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`, requestId = randomUUID()
      assert.equal((await get('/auth/session', browser)).response.status, 401)
      const staleAccountCookie = `${browser}; poker_account=stale-session-token-that-is-not-in-this-test-database`
      assert.equal((await get('/auth/session', staleAccountCookie)).response.status, 401)
      const first = await post('/phone/start', { phone, purpose: 'register', requestId }, browser)
      assert.equal(first.response.status, 200)
      assert.equal(first.data.status, 'pending')
      const repeated = await post('/phone/start', { phone, purpose: 'register', requestId }, browser)
      const otherId = await post('/phone/start', { phone, purpose: 'register', requestId: randomUUID() }, browser)
      assert.equal(repeated.response.status, 200)
      assert.equal(otherId.response.status, 200)
      assert.equal(repeated.data.id, first.data.id)
      assert.equal(otherId.data.id, first.data.id)
      assert.equal(providerCalls, 1)
      const status = await post('/phone/status', { id: first.data.id }, browser)
      assert.equal(status.response.status, 200)
      assert.equal(status.data.status, 'verified')
      assert.equal(providerStatusCalls, 1)
      const complete = await post('/phone/complete', {
        id: first.data.id, username: `phone_limit_${randomUUID().slice(0, 8)}`, password: 'Isolated-test-password-2026',
        ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true, personalDataConsent: true
      }, staleAccountCookie)
      assert.equal(complete.response.status, 200)
      assert.equal(complete.data.user.phone, phone)
      assert.equal(complete.data.token, COOKIE_MARKER)
      const setCookie = complete.response.headers.get('set-cookie') || ''
      assert.match(setCookie, /^poker_account=[^;]+;/)
      assert.match(setCookie, /HttpOnly/)
      assert.match(setCookie, /SameSite=Lax/)
      assert.match(setCookie, /Path=\//)
      const accountToken = setCookie.match(/(?:^|,\s*)poker_account=([^;,]+)/)?.[1]
      assert.ok(accountToken)
      const sessionCookie = `poker_account=${accountToken}`
      const authenticated = await get('/auth/session', sessionCookie)
      assert.equal(authenticated.response.status, 200)
      assert.equal(authenticated.data.user.id, complete.data.user.id)
      assert.equal((await get('/auth/session', sessionCookie)).response.status, 200, 'refresh keeps the cookie session')
      assert.equal(await prisma.accountSession.count({ where: { userId: complete.data.user.id } }), 1)
      assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: complete.data.user.id }, entryType: 'ACCOUNT_OPENING_GRANT' } }), 1)
      const registrationAcceptances = await prisma.legalAcceptance.findMany({ where: { userId: complete.data.user.id, context: 'REGISTRATION' }, include: { document: true } })
      assert.equal(registrationAcceptances.length, 4)
      assert.ok(registrationAcceptances.every(row => row.version === row.document.version && row.contentHash === row.document.contentHash))
      assert.equal(registrationAcceptances.find(row => row.document.type === 'PERSONAL_DATA_CONSENT')?.version, '1.1')

      const duplicate = await post('/phone/complete', {
        id: first.data.id, username: complete.data.user.username, password: 'Isolated-test-password-2026',
        ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true, personalDataConsent: true
      }, browser)
      assert.equal(duplicate.response.status, 403)
      assert.equal(await prisma.accountSession.count({ where: { userId: complete.data.user.id } }), 1)

      const logout = await post('/auth/logout', {}, sessionCookie)
      assert.equal(logout.response.status, 200)
      assert.match(logout.response.headers.get('set-cookie') || '', /poker_account=;/)
      assert.equal((await get('/auth/session', sessionCookie)).response.status, 401)
    })

    await t.test('unverified registration never creates a user or account session', async () => {
      await redis.flushdb()
      const browser = cookie(), phone = `+7998${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`
      const started = await post('/phone/start', { phone, purpose: 'register', requestId: randomUUID() }, browser)
      const rejected = await post('/phone/complete', {
        id: started.data.id, username: `phone_unverified_${randomUUID().slice(0, 8)}`, password: 'Isolated-test-password-2026',
        ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true, personalDataConsent: true
      }, browser)
      assert.equal(rejected.response.status, 403)
      assert.equal((await get('/auth/session', browser)).response.status, 401)
      assert.equal(await prisma.user.count({ where: { phone } }), 0)
      assert.equal(await prisma.accountSession.count({ where: { user: { phone } } }), 0)
    })

    await t.test('two simultaneous completions create one user and one session', async () => {
      await redis.flushdb()
      const browser = cookie(), phone = `+7997${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`
      const started = await post('/phone/start', { phone, purpose: 'register', requestId: randomUUID() }, browser)
      const verified = await post('/phone/status', { id: started.data.id }, browser)
      assert.equal(verified.data.status, 'verified')
      const payload = {
        id: started.data.id, username: `phone_concurrent_${randomUUID().slice(0, 8)}`, password: 'Isolated-test-password-2026',
        ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true, personalDataConsent: true
      }
      const results = await Promise.all([post('/phone/complete', payload, browser), post('/phone/complete', payload, browser)])
      assert.deepEqual(results.map(result => result.response.status).sort(), [200, 403])
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } })
      assert.equal(await prisma.accountSession.count({ where: { userId: user.id } }), 1)
      assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: user.id }, entryType: 'ACCOUNT_OPENING_GRANT' } }), 1)
    })

    await t.test('new cookies cannot bypass the normalized phone limit; 429 precedes SMS.ru', async () => {
      await redis.flushdb()
      const baseline = providerCalls
      for (let i = 0; i < PHONE_START_LIMITS.phone.requests; i++) {
        const phone = i % 2 ? '89991001002' : '+79991001002'
        const result = await post('/phone/start', { phone, purpose: 'register', requestId: randomUUID() })
        assert.equal(result.response.status, 200)
      }
      const limited = await post('/phone/start', { phone: '+79991001002', purpose: 'register', requestId: randomUUID() })
      assert.equal(limited.response.status, 429)
      assert.ok(Number(limited.response.headers.get('retry-after')) > 0)
      assert.equal(providerCalls - baseline, PHONE_START_LIMITS.phone.requests)
    })

    await t.test('changing phones and spoofing forwarded headers cannot bypass the socket IP limit', async () => {
      await redis.flushdb()
      const baseline = providerCalls
      for (let i = 0; i < PHONE_START_LIMITS.ip.requests; i++) {
        const result = await post('/phone/start', { phone: `+7999200${String(i).padStart(4, '0')}`, purpose: 'register', requestId: randomUUID() }, cookie(), {
          'x-forwarded-for': `198.51.100.${i + 1}`, 'x-real-ip': `203.0.113.${i + 1}`
        })
        assert.equal(result.response.status, 200, JSON.stringify(result.data))
      }
      const limited = await post('/phone/start', { phone: '+79992009999', purpose: 'register', requestId: randomUUID() }, cookie(), {
        'x-forwarded-for': '198.51.100.254', 'x-real-ip': '203.0.113.254'
      })
      assert.equal(limited.response.status, 429)
      assert.equal(providerCalls - baseline, PHONE_START_LIMITS.ip.requests)
    })

    await t.test('Redis TTL permits a new request after the fixed window', async () => {
      await redis.flushdb()
      const phone = '+79993001001', ip = '198.51.100.90'
      const short = { phone: { requests: 1, windowMs: 80 }, ip: { requests: 1, windowMs: 80 } }
      assert.equal((await consumePhoneStartCounters(phone, ip, short)).allowed, true)
      assert.equal((await consumePhoneStartCounters(phone, ip, short)).allowed, false)
      await new Promise(resolve => setTimeout(resolve, 120))
      assert.equal((await consumePhoneStartCounters(phone, ip, short)).allowed, true)
    })

    await t.test('parallel requests cannot pass more than the shared IP limit', async () => {
      await redis.flushdb()
      const attempts = await Promise.all(Array.from({ length: PHONE_START_LIMITS.ip.requests + 10 }, (_, index) =>
        consumePhoneStartCounters(`+7999400${String(index).padStart(4, '0')}`, '198.51.100.91')))
      assert.equal(attempts.filter(attempt => attempt.allowed).length, PHONE_START_LIMITS.ip.requests)
    })

    await t.test('shared storage outage returns 503 without calling SMS.ru', async () => {
      const baseline = providerCalls
      closePhoneStartLimitStore()
      process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
      try {
        const result = await post('/phone/start', { phone: '+79995001001', purpose: 'register', requestId: randomUUID() })
        assert.equal(result.response.status, 503)
        assert.equal(providerCalls, baseline)
      } finally {
        closePhoneStartLimitStore()
        process.env.REDIS_URL = testRedisUrl
      }
    })
  } finally {
    globalThis.fetch = originalFetch
    closePhoneStartLimitStore()
    redis.disconnect()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries({
      REDIS_URL: previousRedisUrl, SMS_RU_API_ID: previousSmsId,
      SMS_RU_MODE: previousSmsMode, PHONE_TRUSTED_PROXY_IPS: previousTrustedProxies
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
