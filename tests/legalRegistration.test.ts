import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { acceptRegistrationLegalDocuments, assertRegistrationLegalConfirmations } from '../server/services/legalService'

const confirmations = { ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true, personalDataConsent: true }

test('new registration records the four mandatory snapshots once and excludes distribution consent', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const suffix = Date.now()
  const user = await db.user.create({ data: { username: `legal_registration_${suffix}`, passwordHash: 'test' } })
  const requestId = randomUUID()
  try {
    await db.$transaction(tx => acceptRegistrationLegalDocuments(tx, { userId: user.id, requestId, confirmations, ip: '127.0.0.1', userAgent: 'registration-test' }))
    await db.$transaction(tx => acceptRegistrationLegalDocuments(tx, { userId: user.id, requestId, confirmations, ip: '127.0.0.1', userAgent: 'registration-test-retry' }))
    const rows = await db.legalAcceptance.findMany({ where: { requestId }, include: { document: true }, orderBy: { document: { type: 'asc' } } })
    assert.deepEqual(rows.map(row => row.document.type), ['AGE_CONFIRMATION', 'PERSONAL_DATA_CONSENT', 'PRIVACY_POLICY', 'USER_AGREEMENT'])
    assert.ok(rows.every(row => row.context === 'REGISTRATION' && row.version === row.document.version && row.contentHash === row.document.contentHash))
    assert.equal(rows.some(row => row.document.type === 'PERSONAL_DATA_DISTRIBUTION'), false)
    assert.equal(rows.length, 4)
    assert.throws(() => assertRegistrationLegalConfirmations({ ...confirmations, personalDataConsent: false }))

    const rollbackUser = await db.user.create({ data: { username: `legal_registration_rollback_${suffix}`, passwordHash: 'test' } })
    const rollbackRequestId = randomUUID()
    await assert.rejects(() => db.$transaction(async tx => {
      await acceptRegistrationLegalDocuments(tx, { userId: rollbackUser.id, requestId: rollbackRequestId, confirmations, ip: '127.0.0.1', userAgent: 'registration-test' })
      throw new Error('rollback')
    }))
    assert.equal(await db.legalAcceptance.count({ where: { requestId: rollbackRequestId } }), 0)
    await db.user.delete({ where: { id: rollbackUser.id } })
  } finally {
    await db.user.delete({ where: { id: user.id } })
    await db.$disconnect()
  }
})

test('registration confirmation validator rejects consentless and partial API payloads', () => {
  assert.throws(() => assertRegistrationLegalConfirmations({}), error => error?.statusCode === 400)
  assert.throws(() => assertRegistrationLegalConfirmations({ ageConfirmed: true, termsAccepted: true, privacyAcknowledged: true }), error => error?.statusCode === 400)
  assert.doesNotThrow(() => assertRegistrationLegalConfirmations(confirmations))
})
