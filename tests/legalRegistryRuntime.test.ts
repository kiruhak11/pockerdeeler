import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { legalDocumentSnapshots } from '../app/data/legalDocuments'
import { assertLegalDocumentSnapshot, currentLegalDocuments, ensureLegalDocuments, legalContentHash } from '../server/services/legalService'
import { getDistributionPermissions } from '../server/services/distributionConsentService'
import { seasonLeaderboard } from '../server/services/seasonService'

const dbUrl = process.env.DATABASE_URL
const productionSnapshotTest = process.env.LEGAL_PRODUCTION_SNAPSHOT_TEST === '1'

const historicalHashes = {
  GAME_RULES: '047dc69e928c23a5ce10cfdf2a2795841392098e895992814cc679c45b901fce',
  PERSONAL_DATA_CONSENT: '457578044abf383531692ccd7485164e7d9a53b8a43449ac2ed809ce0096209c',
  REQUISITES: 'ff90ec280cfe63e8c2d9919f58aff3288792af0f59521294c2c50f7604d3c104'
} as const

const releaseHashes = {
  GAME_RULES: '8111805ca94d745aa4534cd6aa2968b0385e310705e226aab80e436562dbc439',
  PERSONAL_DATA_CONSENT: '30d102aa793e0cd738ac7bfe17fe688fafae0890ba6707b8645be86f7b02d636',
  REQUISITES: 'a1d265ad335655032f77bcf54ef22dacca849d44b7eff5e0a7742103a382f537'
} as const

test('changed published documents have new versions and retain their release content', () => {
  for (const [type, hash] of Object.entries(releaseHashes)) {
    const snapshot = legalDocumentSnapshots.find(item => item.type === type)
    assert.ok(snapshot)
    assert.equal(snapshot.version, '1.1')
    assert.equal(legalContentHash(snapshot.content), hash)
  }
  for (const [type, hash] of Object.entries(historicalHashes)) {
    const historicalSnapshot = legalDocumentSnapshots.find(item => item.type === type && item.version === '1.0')
    assert.equal(historicalSnapshot, undefined)
    assert.notEqual(hash, releaseHashes[type as keyof typeof releaseHashes])
  }
})

test('restored production registry upgrades append-only from partial initialization', { skip: !dbUrl || !productionSnapshotTest }, async () => {
  const db = new PrismaClient()
  const syntheticUserId = randomUUID()
  const syntheticRequestId = randomUUID()

  try {
    const beforeCount = await db.legalDocument.count()
    const historicalRows = new Map<string, { id: string; content: string; contentHash: string; isActive: boolean }>()
    for (const [type, contentHash] of Object.entries(historicalHashes)) {
      const row = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type, version: '1.0' } } })
      assert.equal(row.contentHash, contentHash)
      historicalRows.set(type, { id: row.id, content: row.content, contentHash: row.contentHash, isActive: row.isActive })
    }

    const gameRulesV1 = historicalRows.get('GAME_RULES')!
    const originalAcceptances = await db.legalAcceptance.findMany({
      where: { documentId: gameRulesV1.id },
      select: { id: true, documentId: true, version: true, contentHash: true, acceptedAt: true },
      orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }]
    })
    assert.equal(originalAcceptances.length, 4)
    assert.ok(originalAcceptances.every(row => row.version === '1.0' && row.contentHash === historicalHashes.GAME_RULES))

    const expectedInactive = [
      ['USER_AGREEMENT', '7cda655c287323e33dc5840f8d7ff59ab48b06baacfdaf34c7b2cbd80be333c5'],
      ['PUBLIC_OFFER', '060f3c26e1317975088bae2deea38238014fe5b6e0df200b786ee3a3b574edd9'],
      ['VIRTUAL_CHIPS_RULES', '8cb6df4f8ea697477a98846f3a4d74a9cbb4ce52a435e67b74b256e7bd7ba3b1']
    ] as const
    for (const [type, contentHash] of expectedInactive) {
      const row = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type, version: '1.0' } } })
      assert.equal(row.isActive, false)
      assert.equal(row.contentHash, contentHash)
    }

    await ensureLegalDocuments()

    for (const [type, contentHash] of Object.entries(historicalHashes)) {
      const oldRow = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type, version: '1.0' } } })
      const newRow = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type, version: '1.1' } } })
      const previous = historicalRows.get(type)!
      assert.deepEqual({ id: oldRow.id, content: oldRow.content, contentHash: oldRow.contentHash }, { id: previous.id, content: previous.content, contentHash: previous.contentHash })
      assert.equal(oldRow.isActive, false)
      assert.equal(newRow.contentHash, releaseHashes[type as keyof typeof releaseHashes])
      assert.equal(newRow.isActive, true)
      assert.equal(contentHash, oldRow.contentHash)
    }

    for (const type of ['USER_AGREEMENT', 'PUBLIC_OFFER', 'VIRTUAL_CHIPS_RULES', 'PRIVACY_POLICY', 'REFUND_POLICY', 'COOKIES_POLICY']) {
      const row = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type, version: '1.0' } } })
      assert.equal(row.isActive, true)
    }

    const acceptedAfterInitialization = await db.legalAcceptance.findMany({
      where: { documentId: gameRulesV1.id },
      select: { id: true, documentId: true, version: true, contentHash: true, acceptedAt: true },
      orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }]
    })
    assert.deepEqual(acceptedAfterInitialization, originalAcceptances)
    assert.equal(await db.legalAcceptance.count({ where: { documentId: (await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type: 'GAME_RULES', version: '1.1' } } })).id } }), 0)

    await db.user.create({ data: { id: syntheticUserId, username: `legal_historical_${syntheticUserId.slice(0, 8)}`, passwordHash: 'test' } })
    await db.legalAcceptance.create({ data: {
      userId: syntheticUserId,
      documentId: gameRulesV1.id,
      version: '1.0',
      contentHash: historicalHashes.GAME_RULES,
      context: 'VIRTUAL_CHIPS',
      ip: '127.0.0.1',
      userAgent: 'legal-versioning-regression-test',
      requestId: syntheticRequestId
    } })

    for (const context of ['PREMIUM', 'VIRTUAL_CHIPS', 'PERSONAL_DATA'] as const) {
      const docs = await currentLegalDocuments(context)
      assert.ok(docs.length > 0)
      if (context === 'VIRTUAL_CHIPS') {
        const currentGameRules = docs.find(document => document.type === 'GAME_RULES')
        assert.equal(currentGameRules?.version, '1.1')
        assert.equal(currentGameRules?.accepted, false)
      }
    }
    const historicalUserDocs = await currentLegalDocuments('VIRTUAL_CHIPS', syntheticUserId)
    assert.equal(historicalUserDocs.find(document => document.type === 'GAME_RULES')?.accepted, false)

    const countAfterFirstInitialization = await db.legalDocument.count()
    assert.equal(countAfterFirstInitialization, beforeCount + 6)
    for (let run = 0; run < 10; run += 1) await ensureLegalDocuments()
    assert.equal(await db.legalDocument.count(), countAfterFirstInitialization)

    const concurrent = await Promise.allSettled(Array.from({ length: 50 }, () => ensureLegalDocuments()))
    assert.equal(concurrent.filter(result => result.status === 'rejected').length, 0)
    assert.equal(await db.legalDocument.count(), countAfterFirstInitialization)

    const duplicateGroups = await db.legalDocument.groupBy({ by: ['type', 'version'], _count: { _all: true }, having: { id: { _count: { gt: 1 } } } })
    assert.deepEqual(duplicateGroups, [])
    const registryTypes = [...new Set(legalDocumentSnapshots.map(document => document.type))]
    for (const type of registryTypes) assert.equal(await db.legalDocument.count({ where: { type, isActive: true } }), 1, `${type} must have one active version`)
    assert.equal(await db.legalAcceptance.count({ where: { documentId: gameRulesV1.id, version: { not: '1.0' } } }), 0)
    const orphanCount = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM legal_acceptances a LEFT JOIN legal_documents d ON d.id = a.document_id WHERE d.id IS NULL`
    assert.equal(Number(orphanCount[0]?.count ?? -1), 0)
  } finally {
    await db.user.deleteMany({ where: { id: syntheticUserId } })
    await db.$disconnect()
  }
})

test('same legal version with different content is still rejected without overwriting', () => {
  const snapshot = legalDocumentSnapshots.find(item => item.type === 'GAME_RULES' && item.version === '1.1')!
  const row = {
    type: snapshot.type,
    version: snapshot.version,
    title: snapshot.title,
    content: `${snapshot.content}\nconflict`,
    contentPath: snapshot.publicPath,
    contentHash: legalContentHash(snapshot.content)
  }
  assert.throws(() => assertLegalDocumentSnapshot(row, snapshot), error => error?.statusCode === 500 && /GAME_RULES 1\.1/.test(error.message))
  assert.match(row.content, /conflict$/)
})

test('distribution consent and season leaderboard do not depend on unrelated document revalidation', { skip: !dbUrl }, async () => {
  await ensureLegalDocuments()
  const permissions = await getDistributionPermissions(randomUUID())
  assert.deepEqual(permissions.categories, [])
  const leaderboard = await seasonLeaderboard('tableRating')
  assert.ok(Array.isArray(leaderboard.entries))
})

test('all current legal snapshots have deterministic hashes', () => {
  for (const snapshot of legalDocumentSnapshots) assert.equal(legalContentHash(snapshot.content).length, 64)
})
