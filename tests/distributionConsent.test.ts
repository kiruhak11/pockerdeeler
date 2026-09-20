import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { assertDistributionCategories, filterPublicUserData, getDistributionPermissions, saveDistributionPermissions } from '../server/services/distributionConsentService'

const dbUrl = process.env.DATABASE_URL

test('distribution consent is granular, default-off, idempotent, revocable, and server-versioned', { skip: !dbUrl }, async () => {
  const db = new PrismaClient()
  const suffix = Date.now()
  const user = await db.user.create({ data: { username: `distribution_${suffix}`, passwordHash: 'test' } })
  try {
    assert.deepEqual((await getDistributionPermissions(user.id)).categories, [])
    assert.equal(await db.personalDataDistributionConsent.count({ where: { userId: user.id } }), 0)

    const partial = await saveDistributionPermissions({ userId: user.id, categories: ['NICKNAME', 'RATING', 'GAME_STATISTICS'], ip: '127.0.0.1', userAgent: 'distribution-test' })
    assert.deepEqual(new Set(partial.categories), new Set(['NICKNAME', 'RATING', 'GAME_STATISTICS']))
    assert.equal(partial.documentVersion, '1.0')
    assert.deepEqual(new Set((await getDistributionPermissions(user.id)).categories), new Set(['NICKNAME', 'RATING', 'GAME_STATISTICS']))
    assert.equal(await db.legalAcceptance.count({ where: { userId: user.id, context: 'PERSONAL_DATA_DISTRIBUTION' } }), 1)
    assert.equal(await db.personalDataDistributionAudit.count({ where: { userId: user.id } }), 1)

    await saveDistributionPermissions({ userId: user.id, categories: ['NICKNAME', 'RATING', 'GAME_STATISTICS', 'GAME_STATISTICS'], ip: '127.0.0.1', userAgent: 'distribution-test-retry' })
    assert.equal(await db.personalDataDistributionAudit.count({ where: { userId: user.id } }), 1)
    await assert.rejects(() => saveDistributionPermissions({ userId: user.id, categories: ['PHONE'], ip: '127.0.0.1', userAgent: 'distribution-test' }), error => error?.statusCode === 400)
    const spoofedVersion = await saveDistributionPermissions({ userId: user.id, categories: ['NICKNAME', 'RATING', 'GAME_STATISTICS'], ip: '127.0.0.1', userAgent: 'distribution-test', ...( { documentVersion: '9.9' } as Record<string, unknown>) } as never)
    assert.equal(spoofedVersion.documentVersion, '1.0')

    await saveDistributionPermissions({ userId: user.id, categories: ['NICKNAME'], ip: '127.0.0.1', userAgent: 'distribution-test-update' })
    const afterPartialRevoke = await getDistributionPermissions(user.id)
    assert.deepEqual(afterPartialRevoke.categories, ['NICKNAME'])
    assert.equal(await db.personalDataDistributionAudit.count({ where: { userId: user.id } }), 2)

    await saveDistributionPermissions({ userId: user.id, categories: [], ip: '127.0.0.1', userAgent: 'distribution-test-revoke' })
    assert.deepEqual((await getDistributionPermissions(user.id)).categories, [])
    assert.equal(await db.personalDataDistributionConsent.count({ where: { userId: user.id, revokedAt: { not: null } } }), 1)
    assert.equal(await db.personalDataDistributionPermission.count({ where: { userId: user.id, isActive: true } }), 0)
    assert.equal(await db.legalAcceptance.count({ where: { userId: user.id, context: 'PERSONAL_DATA_DISTRIBUTION' } }), 1)
    assert.equal(await db.personalDataDistributionAudit.count({ where: { userId: user.id } }), 3)

    assert.deepEqual(assertDistributionCategories(['NICKNAME', 'RATING', 'RATING']), ['NICKNAME', 'RATING'])
    assert.deepEqual(filterPublicUserData({ username: 'visible', balance: 100, rating: 10, achievements: ['x'] }, new Set(['NICKNAME', 'RATING']), { username: 'NICKNAME', balance: 'VIRTUAL_BALANCE', rating: 'RATING', achievements: 'ACHIEVEMENTS' }), { username: 'visible', rating: 10 })
  } finally {
    await db.user.delete({ where: { id: user.id } })
    await db.$disconnect()
  }
})

test('distribution category enum rejects unknown values', () => {
  assert.throws(() => assertDistributionCategories(['EMAIL']), error => error?.statusCode === 400)
  assert.deepEqual(assertDistributionCategories([]), [])
})
