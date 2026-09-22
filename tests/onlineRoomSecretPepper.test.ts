import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveRoomSecretPepper, ROOM_SECRET_PEPPER_ERROR } from '../server/utils/roomSecretPepper'

const production = (pepper?: string) => ({ NODE_ENV: 'production', ...(pepper === undefined ? {} : { ROOM_SECRET_PEPPER: pepper }) })

test('production requires ROOM_SECRET_PEPPER', () => {
  for (const environment of [production(), production(''), production('   ')]) {
    assert.throws(() => resolveRoomSecretPepper(environment), new RegExp(ROOM_SECRET_PEPPER_ERROR))
  }
})

test('production rejects known development and compose placeholders', () => {
  for (const pepper of ['dev-pepper', 'DEV-PEPPER', 'change-me-room-pepper', 'dev-room-pepper', 'change-me']) {
    assert.throws(() => resolveRoomSecretPepper(production(pepper)), new RegExp(ROOM_SECRET_PEPPER_ERROR))
  }
})

test('production accepts a configured non-placeholder pepper without exposing it in errors', () => {
  const pepper = 'production-secret-value-for-tests'
  assert.equal(resolveRoomSecretPepper(production(pepper)), pepper)
  assert.throws(() => resolveRoomSecretPepper(production(' ')), error => {
    return error instanceof Error && error.message === ROOM_SECRET_PEPPER_ERROR && !error.message.includes(pepper)
  })
})

test('development and test environments retain the controlled fallback', () => {
  assert.equal(resolveRoomSecretPepper({ NODE_ENV: 'development' }), 'dev-pepper')
  assert.equal(resolveRoomSecretPepper({ NODE_ENV: 'test' }), 'dev-pepper')
  assert.equal(resolveRoomSecretPepper({ NODE_ENV: 'test', ROOM_SECRET_PEPPER: 'test-pepper' }), 'test-pepper')
})

test('production compose requires an external pepper and has no placeholder fallback', () => {
  for (const file of ['docker-compose.prod.yml', 'docker-compose-prod.yml']) {
    const compose = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(compose, /ROOM_SECRET_PEPPER:\s*\$\{ROOM_SECRET_PEPPER:\?ROOM_SECRET_PEPPER must be set in the production environment\}/)
    assert.doesNotMatch(compose, /ROOM_SECRET_PEPPER:\s*\$\{ROOM_SECRET_PEPPER:-/)
    assert.doesNotMatch(compose, /ROOM_SECRET_PEPPER\s*:\s*(dev-pepper|dev-room-pepper|change-me-room-pepper)/)
  }
})
