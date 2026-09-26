import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseYandexFrameAncestors, securityPolicyForPath } from '../server/middleware/securityHeaders'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

test('WEB framing stays denied and does not gain Yandex SDK permissions', () => {
  const policy = securityPolicyForPath('/rooms', { NODE_ENV: 'production' })
  assert.match(policy.csp, /frame-ancestors 'none'/)
  assert.doesNotMatch(policy.csp, /sdk\.games\.s3\.yandex\.net/)
  assert.doesNotMatch(policy.csp, /s3\.mds\.yandex\.net/)
  assert.equal(policy.xFrameOptions, 'DENY')
  assert.match(securityPolicyForPath('/online/ROOM1', { NODE_ENV: 'production', YANDEX_GAMES_FRAME_ANCESTORS: 'https://games.example' }).csp, /frame-ancestors 'none'/)
})

test('Yandex framing fails closed without an exact configured ancestor', () => {
  assert.match(securityPolicyForPath('/yandex', { NODE_ENV: 'production' }).csp, /frame-ancestors 'none'/)
  assert.deepEqual(parseYandexFrameAncestors('https://games.example https://publisher.example', 'production'), ['https://games.example', 'https://publisher.example'])
  assert.deepEqual(parseYandexFrameAncestors('https://games.example/path', 'production'), [])
  assert.deepEqual(parseYandexFrameAncestors('https://*.example', 'production'), [])
  assert.deepEqual(parseYandexFrameAncestors('http://games.example', 'production'), [])
  assert.deepEqual(parseYandexFrameAncestors('http://localhost:3000', 'development'), ['http://localhost:3000'])
})

test('Yandex CSP allows only its official SDK script and exact app WebSocket origin', () => {
  const policy = securityPolicyForPath('/yandex/online/ABC123', {
    NODE_ENV: 'production',
    YANDEX_GAMES_FRAME_ANCESTORS: 'https://games.example',
    NUXT_PUBLIC_APP_URL: 'https://pocker.kiruhak11.ru'
  })
  assert.match(policy.csp, /frame-ancestors https:\/\/games\.example/)
  assert.match(policy.csp, /script-src 'self' 'unsafe-inline' https:\/\/sdk\.games\.s3\.yandex\.net/)
  assert.match(policy.csp, /connect-src 'self' wss:\/\/pocker\.kiruhak11\.ru/)
  assert.match(policy.csp, /connect-src[^;]*https:\/\/s3\.mds\.yandex\.net/)
  assert.doesNotMatch(policy.csp, /connect-src[^;]*\bws:|connect-src[^;]*\bwss:\s*(?:;|$)/)
  assert.match(policy.csp, /img-src 'self' data: blob:/)
  assert.doesNotMatch(policy.csp, /img-src[^;]*https?:/)
  assert.equal(policy.xFrameOptions, undefined)
})

test('Yandex game routes use route paths, keep avatar fallback and retry/disclosure UX', () => {
  const shell = source('app/pages/yandex.vue')
  const create = source('app/pages/online/create.vue')
  const room = source('app/pages/online/[code].vue')
  const adapter = source('app/platform/yandexGames.ts')
  const harness = source('app/pages/dev/yandex-iframe.vue')
  assert.match(create, /alias: \['\/yandex\/online\/create'\]/)
  assert.match(room, /alias: \['\/yandex\/online\/:code'\]/)
  assert.match(shell, /Все выигрыши и награды в Pocker — только внутренняя виртуальная валюта/)
  assert.doesNotMatch(shell, /identity\.avatarUrl|<img/)
  assert.match(shell, /Повторить/)
  assert.match(shell, /await adapter\(\)\.gameReady\(\)/)
  assert.doesNotMatch(adapter, /getPhoto|avatarUrl/)
  assert.match(adapter, /initialization = null/)
  assert.match(harness, /if \(!import\.meta\.dev\).*404/)
  assert.match(harness, /src="\/yandex"/)
  assert.match(harness, /src="\/rooms"/)
})
