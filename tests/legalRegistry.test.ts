import test from 'node:test'
import assert from 'node:assert/strict'
import { getLegalDocument, legalDocumentSnapshots, legalDocuments } from '../app/data/legalDocuments'

const publicSlugs = [
  'user-agreement',
  'offer',
  'virtual-chips',
  'game-rules',
  'privacy',
  'personal-data-consent',
  'personal-data-distribution',
  'refunds',
  'cookies',
  'requisites'
]

test('legal registry contains exactly the ten current public documents', () => {
  assert.deepEqual(legalDocuments.map(document => document.slug), publicSlugs)
  assert.equal(new Set(legalDocuments.map(document => document.type)).size, 10)
  assert.ok(legalDocuments.every(document => document.version === '1.0'))
  assert.equal(getLegalDocument('game-rules')?.version, '1.0')
  assert.equal(getLegalDocument('personal-data-consent')?.version, '1.0')
  assert.equal(getLegalDocument('requisites')?.version, '1.0')
  assert.equal(legalDocuments.some(document => /чек-лист|checklist/i.test(`${document.title} ${document.summary} ${JSON.stringify(document.sections)}`)), false)
})

test('public registry routes resolve and internal snapshots are not public', () => {
  for (const slug of publicSlugs) {
    assert.equal(getLegalDocument(slug)?.slug, slug)
  }
  assert.equal(getLegalDocument('internal-legal-checklist'), undefined)
  assert.equal(legalDocumentSnapshots.filter(document => document.publicPath).length, 10)
  assert.equal(legalDocumentSnapshots.some(document => ['GAME_RULES', 'PERSONAL_DATA_CONSENT', 'REQUISITES'].includes(document.type) && document.version === '1.1'), false)
  assert.ok(legalDocumentSnapshots.filter(document => document.publicPath === null).every(document => ['VIRTUAL_CURRENCY_NOTICE', 'AGE_CONFIRMATION'].includes(document.type)))
})

test('legal registry preserves source document anchors', () => {
  assert.match(JSON.stringify(getLegalDocument('offer')), /ЮKassa/)
  assert.match(JSON.stringify(getLegalDocument('privacy')), /Яндекс Метрика/)
  assert.match(JSON.stringify(getLegalDocument('personal-data-distribution')), /Молчание/)
  assert.match(JSON.stringify(getLegalDocument('cookies')), /Яндекс Реклама/)
  assert.match(JSON.stringify(getLegalDocument('requisites')), /222175187182/)
})
