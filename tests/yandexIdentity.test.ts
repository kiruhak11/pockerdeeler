import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { verifyYandexPlayerSignature } from '../server/services/yandexIdentityService'

const secret = 'yandex-test-secret'
function signed(profile: unknown, signingSecret = secret): string {
  const data = Buffer.from(JSON.stringify(profile))
  const mac = createHmac('sha256', signingSecret).update(data).digest('base64')
  return `${mac}.${data.toString('base64')}`
}

test('verifies signed Yandex player profile and returns only the verified permanent ID', () => {
  const result = verifyYandexPlayerSignature(signed({ uniqueID: 'verified-yandex-player-123' }), secret)
  assert.deepEqual(result, { providerUserId: 'verified-yandex-player-123' })
})

test('rejects forged signature, modified payload, malformed base64, and wrong secret', () => {
  const valid = signed({ uniqueID: 'verified-yandex-player-123' })
  const [mac, payload] = valid.split('.')
  assert.throws(() => verifyYandexPlayerSignature(`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=.${payload}`, secret), { statusCode: 401 })
  assert.throws(() => verifyYandexPlayerSignature(`${mac}.${Buffer.from('{"uniqueID":"other-player-123"}').toString('base64')}`, secret), { statusCode: 401 })
  assert.throws(() => verifyYandexPlayerSignature('not-base64!.eyJ1bmlxdWVJRCI6Inh4eHh4eHh4In0=', secret), { statusCode: 401 })
  assert.throws(() => verifyYandexPlayerSignature(valid, 'wrong-secret'), { statusCode: 401 })
})

test('missing secret fails closed and dev mock is disabled in production', () => {
  const previousSecret = process.env.YANDEX_GAMES_SECRET
  const previousMock = process.env.YANDEX_GAMES_DEV_MOCK
  const previousNodeEnv = process.env.NODE_ENV
  try {
    delete process.env.YANDEX_GAMES_SECRET
    process.env.YANDEX_GAMES_DEV_MOCK = 'true'
    process.env.NODE_ENV = 'production'
    assert.throws(() => verifyYandexPlayerSignature('dev-mock-authorized-player'), { statusCode: 503 })
    assert.throws(() => verifyYandexPlayerSignature(signed({ uniqueID: 'verified-yandex-player-123' }), undefined), { statusCode: 503 })
    process.env.NODE_ENV = 'test'
    assert.deepEqual(verifyYandexPlayerSignature('dev-mock-authorized-player'), { providerUserId: 'dev-yandex-authorized' })
  } finally {
    if (previousSecret === undefined) delete process.env.YANDEX_GAMES_SECRET
    else process.env.YANDEX_GAMES_SECRET = previousSecret
    if (previousMock === undefined) delete process.env.YANDEX_GAMES_DEV_MOCK
    else process.env.YANDEX_GAMES_DEV_MOCK = previousMock
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})
