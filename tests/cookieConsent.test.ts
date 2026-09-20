import assert from 'node:assert/strict'
import test from 'node:test'
import { getLegalDocument } from '../app/data/legalDocuments'
import {
  createCookiePreferences,
  getCurrentCookiePreferences,
  withPolicyVersion
} from '../app/utils/cookieConsent'
import {
  initializeAnalyticsIfAllowed,
  resetAnalyticsGateForTests
} from '../app/utils/analyticsGate'

test('cookie consent uses the current Cookies Policy version and requires a new choice after revision', () => {
  const currentVersion = getLegalDocument('cookies')!.version
  const stored = withPolicyVersion(createCookiePreferences(false, new Date('2026-09-20T00:00:00.000Z')), currentVersion)
  assert.equal(getCurrentCookiePreferences(stored, currentVersion)?.analyticsAllowed, false)
  assert.equal(getCurrentCookiePreferences(stored, '1.1'), null)
  assert.equal(getCurrentCookiePreferences({ ...stored, userId: 'must-not-be-stored' }, currentVersion)?.policyVersion, currentVersion)
})

test('future analytics initializer is blocked until analytics consent is enabled', () => {
  resetAnalyticsGateForTests()
  let calls = 0
  assert.equal(initializeAnalyticsIfAllowed(false, () => { calls += 1 }), false)
  assert.equal(calls, 0)
  assert.equal(initializeAnalyticsIfAllowed(true, () => { calls += 1 }), true)
  assert.equal(calls, 1)
  assert.equal(initializeAnalyticsIfAllowed(true, () => { calls += 1 }), false)
  assert.equal(calls, 1)
  resetAnalyticsGateForTests()
})
