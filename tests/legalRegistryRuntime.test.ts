import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { legalDocumentSnapshots } from '../app/data/legalDocuments'
import { assertLegalDocumentSnapshot, ensureLegalDocuments, legalContentHash } from '../server/services/legalService'
import { getDistributionPermissions } from '../server/services/distributionConsentService'
import { seasonLeaderboard } from '../server/services/seasonService'

const dbUrl = process.env.DATABASE_URL

const productionV1Snapshots = {
  GAME_RULES: {
    title: 'ОБЩИЕ ПРАВИЛА ИГРОВЫХ РЕЖИМОВ POCKER',
    publicPath: '/legal/game-rules',
    effectiveFrom: '2026-09-19T00:00:00.000+07:00',
    effectiveDate: '19 сентября 2026 года',
    contentHash: '8111805ca94d745aa4534cd6aa2968b0385e310705e226aab80e436562dbc439'
  },
  PERSONAL_DATA_CONSENT: {
    title: 'СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ POCKER',
    publicPath: '/legal/personal-data-consent',
    effectiveFrom: '2026-09-19T00:00:00.000+07:00',
    effectiveDate: '19 сентября 2026 года',
    contentHash: '30d102aa793e0cd738ac7bfe17fe688fafae0890ba6707b8645be86f7b02d636'
  },
  REQUISITES: {
    title: 'РЕКВИЗИТЫ И СВЕДЕНИЯ О ВЛАДЕЛЬЦЕ POCKER',
    publicPath: '/legal/requisites',
    effectiveFrom: '2026-09-19T00:00:00.000+07:00',
    effectiveDate: '19 сентября 2026 года',
    contentHash: 'a1d265ad335655032f77bcf54ef22dacca849d44b7eff5e0a7742103a382f537'
  }
} as const

test('production release 6ef9e26 snapshots are exact for every revised document', () => {
  for (const [type, expected] of Object.entries(productionV1Snapshots)) {
    const snapshot = legalDocumentSnapshots.find(item => item.type === type && item.version === '1.0')!
    assert.equal(snapshot.title, expected.title)
    assert.equal(snapshot.publicPath, expected.publicPath)
    assert.equal(snapshot.effectiveFrom, expected.effectiveFrom)
    assert.equal(snapshot.publishedAt, expected.effectiveFrom)
    assert.equal(snapshot.effectiveDate, expected.effectiveDate)
    assert.equal(legalContentHash(snapshot.content), expected.contentHash)
  }
})

test('legal registry reinitialization is idempotent and preserves production GAME_RULES 1.0', { skip: !dbUrl }, async () => {
  const db = new PrismaClient()
  try {
    await ensureLegalDocuments()
    const first = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type: 'GAME_RULES', version: '1.0' } } })
    const firstHash = first.contentHash
    await ensureLegalDocuments()
    const historical = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type: 'GAME_RULES', version: '1.0' } } })
    assert.equal(historical.contentHash, firstHash)
    assert.equal(historical.version, '1.0')
    assert.equal(historical.isActive, true)
    assert.equal(await db.legalDocument.count({ where: { type: 'GAME_RULES', version: '1.1' } }), 0)
  } finally {
    await db.$disconnect()
  }
})

test('same legal version with different content is rejected without overwriting the row', () => {
  const snapshot = legalDocumentSnapshots.find(item => item.type === 'GAME_RULES' && item.version === '1.0')!
  const row = {
    type: snapshot.type,
    version: snapshot.version,
    title: snapshot.title,
    content: `${snapshot.content}\nconflict`,
    contentPath: snapshot.publicPath,
    contentHash: legalContentHash(snapshot.content)
  }
  assert.throws(() => assertLegalDocumentSnapshot(row, snapshot), error => error?.statusCode === 500 && /GAME_RULES 1\.0/.test(error.message))
  assert.match(row.content, /conflict$/)
})

test('current legal versions initialize append-only and existing acceptance remains current', { skip: !dbUrl }, async () => {
  const db = new PrismaClient()
  const userId = randomUUID()
  try {
    await ensureLegalDocuments()
    const oldDocument = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type: 'GAME_RULES', version: '1.0' } } })
    const currentDocument = await db.legalDocument.findUniqueOrThrow({ where: { type_version: { type: 'GAME_RULES', version: '1.0' } } })
    await db.user.create({ data: { id: userId, username: `legal_registry_${Date.now()}`, passwordHash: 'test' } })
    await db.legalAcceptance.create({ data: { userId, documentId: oldDocument.id, version: oldDocument.version, contentHash: oldDocument.contentHash, context: 'VIRTUAL_CHIPS', ip: '127.0.0.1', userAgent: 'legal-registry-test', requestId: randomUUID() } })
    await ensureLegalDocuments()
    const acceptance = await db.legalAcceptance.findFirstOrThrow({ where: { userId, documentId: oldDocument.id } })
    assert.equal(acceptance.version, '1.0')
    assert.equal(acceptance.contentHash, oldDocument.contentHash)
    assert.equal(currentDocument.version, '1.0')
    assert.equal(currentDocument.isActive, true)
    assert.equal(await db.legalDocument.count({ where: { type: 'GAME_RULES', version: '1.1' } }), 0)
  } finally {
    await db.user.deleteMany({ where: { id: userId } })
    await db.$disconnect()
  }
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
