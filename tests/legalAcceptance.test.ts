import test from 'node:test'
import assert from 'node:assert/strict'
import { assertLegalConfirmations, legalContentHash } from '../server/services/legalService'

test('legal content hash is deterministic and content-sensitive', () => {
  assert.equal(legalContentHash('редакция 1'), legalContentHash('редакция 1'))
  assert.notEqual(legalContentHash('редакция 1'), legalContentHash('редакция 2'))
  assert.match(legalContentHash('редакция 1'), /^[a-f0-9]{64}$/)
})

test('premium requires explicit terms confirmation', () => {
  assert.throws(() => assertLegalConfirmations('PREMIUM', {}))
  assert.doesNotThrow(() => assertLegalConfirmations('PREMIUM', { termsAccepted: true }))
})

test('virtual chips require three independent confirmations', () => {
  assert.throws(() => assertLegalConfirmations('VIRTUAL_CHIPS', { termsAccepted: true, ageConfirmed: true }))
  assert.throws(() => assertLegalConfirmations('VIRTUAL_CHIPS', { termsAccepted: true, virtualCurrencyAcknowledged: true }))
  assert.doesNotThrow(() => assertLegalConfirmations('VIRTUAL_CHIPS', { termsAccepted: true, virtualCurrencyAcknowledged: true, virtualChipsRulesAccepted: true, ageConfirmed: true }))
})

test('personal data consent remains separate from the offer', () => {
  assert.throws(() => assertLegalConfirmations('PERSONAL_DATA', { termsAccepted: true }))
  assert.doesNotThrow(() => assertLegalConfirmations('PERSONAL_DATA', { personalDataConsent: true }))
})
