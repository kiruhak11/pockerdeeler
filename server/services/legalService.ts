import { createHash } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { legalDocumentSnapshots, type LegalDocumentType } from '../../app/data/legalDocuments'
import { prisma } from '../db/client'

export const legalAcceptanceContexts = ['PREMIUM', 'VIRTUAL_CHIPS', 'PERSONAL_DATA'] as const
export type LegalAcceptanceContext = typeof legalAcceptanceContexts[number]

const requiredTypes: Record<LegalAcceptanceContext, LegalDocumentType[]> = {
  PREMIUM: ['OFFER', 'GAME_RULES'],
  VIRTUAL_CHIPS: ['OFFER', 'GAME_RULES', 'VIRTUAL_CURRENCY_NOTICE', 'AGE_CONFIRMATION'],
  PERSONAL_DATA: ['PERSONAL_DATA_CONSENT']
}

export type LegalConfirmationInput = {
  termsAccepted?: boolean
  virtualCurrencyAcknowledged?: boolean
  ageConfirmed?: boolean
  personalDataConsent?: boolean
}

export function legalContentHash(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function assertLegalConfirmations(context: LegalAcceptanceContext, input: LegalConfirmationInput) {
  if ((context === 'PREMIUM' || context === 'VIRTUAL_CHIPS') && input.termsAccepted !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите принятие Публичной оферты и Правил сервиса' })
  }
  if (context === 'VIRTUAL_CHIPS' && input.virtualCurrencyAcknowledged !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите условия использования виртуальных фишек' })
  }
  if (context === 'VIRTUAL_CHIPS' && input.ageConfirmed !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите, что вам исполнилось 18 лет' })
  }
  if (context === 'PERSONAL_DATA' && input.personalDataConsent !== true) {
    throw createError({ statusCode: 400, message: 'Дайте отдельное согласие на обработку персональных данных' })
  }
}

export async function ensureLegalDocuments(client: Prisma.TransactionClient | typeof prisma = prisma) {
  const idsByType = new Map<LegalDocumentType, string>()
  const now = Date.now()

  for (const snapshot of legalDocumentSnapshots) {
    const contentHash = legalContentHash(snapshot.content)
    const row = await client.legalDocument.upsert({
      where: { type_version: { type: snapshot.type, version: snapshot.version } },
      create: {
        type: snapshot.type,
        version: snapshot.version,
        title: snapshot.title,
        content: snapshot.content,
        contentPath: snapshot.publicPath,
        contentHash,
        effectiveFrom: new Date(snapshot.effectiveFrom),
        publishedAt: new Date(snapshot.publishedAt),
        isActive: false
      },
      update: {}
    })
    if (row.contentHash !== contentHash || row.content !== snapshot.content || row.title !== snapshot.title || row.contentPath !== snapshot.publicPath) {
      throw createError({ statusCode: 500, message: `Редакция ${snapshot.type} ${snapshot.version} уже опубликована с другим содержанием. Создайте новую версию.` })
    }
    if (new Date(snapshot.effectiveFrom).getTime() <= now) {
      const selected = legalDocumentSnapshots
        .filter(item => item.type === snapshot.type && new Date(item.effectiveFrom).getTime() <= now)
        .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0]
      if (selected?.version === snapshot.version) idsByType.set(snapshot.type, row.id)
    }
  }

  for (const [type, id] of idsByType) {
    await client.legalDocument.updateMany({ where: { type, isActive: true, id: { not: id } }, data: { isActive: false } })
    await client.legalDocument.updateMany({ where: { id, isActive: false }, data: { isActive: true } })
  }
  return idsByType
}

export async function currentLegalDocuments(context: LegalAcceptanceContext, userId?: string) {
  await ensureLegalDocuments()
  const types = requiredTypes[context]
  const documents = await prisma.legalDocument.findMany({ where: { type: { in: types }, isActive: true, effectiveFrom: { lte: new Date() } } })
  if (documents.length !== types.length) throw createError({ statusCode: 503, message: 'Актуальные юридические документы временно недоступны' })
  const accepted = userId ? await prisma.legalAcceptance.findMany({ where: { userId, context, documentId: { in: documents.map(item => item.id) } }, select: { documentId: true } }) : []
  const acceptedIds = new Set(accepted.map(item => item.documentId))
  return types.map(type => {
    const item = documents.find(document => document.type === type)!
    return { id: item.id, type: item.type, title: item.title, version: item.version, contentHash: item.contentHash, effectiveFrom: item.effectiveFrom, publishedAt: item.publishedAt, publicPath: item.contentPath, accepted: acceptedIds.has(item.id) }
  })
}

export async function assertCurrentLegalAccepted(userId: string, context: LegalAcceptanceContext) {
  const documents = await currentLegalDocuments(context, userId)
  const missing = documents.filter(document => !document.accepted)
  if (missing.length) {
    throw createError({ statusCode: 409, message: 'Перед операцией примите актуальную редакцию юридических документов', data: { missing: missing.map(document => ({ type: document.type, version: document.version, publicPath: document.publicPath })) } })
  }
  return documents
}

export async function acceptCurrentLegalDocuments(input: {
  userId: string
  context: LegalAcceptanceContext
  confirmations: LegalConfirmationInput
  requestId: string
  ip: string
  userAgent: string
  paymentId?: string | null
  orderId?: string | null
}) {
  assertLegalConfirmations(input.context, input.confirmations)
  return prisma.$transaction(async tx => {
    await ensureLegalDocuments(tx)
    const types = [...requiredTypes[input.context]]
    if (input.context !== 'PERSONAL_DATA' && input.confirmations.personalDataConsent === true) types.push('PERSONAL_DATA_CONSENT')
    const documents = await tx.legalDocument.findMany({ where: { type: { in: types }, isActive: true, effectiveFrom: { lte: new Date() } } })
    if (documents.length !== types.length) throw createError({ statusCode: 503, message: 'Актуальные юридические документы временно недоступны' })
    const rows = []
    for (const document of documents) {
      const acceptanceContext: LegalAcceptanceContext = document.type === 'PERSONAL_DATA_CONSENT' ? 'PERSONAL_DATA' : input.context
      const acceptance = await tx.legalAcceptance.upsert({
        where: { requestId_documentId: { requestId: input.requestId, documentId: document.id } },
        create: {
          userId: input.userId,
          documentId: document.id,
          version: document.version,
          contentHash: document.contentHash,
          context: acceptanceContext,
          ip: input.ip.slice(0, 64) || 'unknown',
          userAgent: input.userAgent.slice(0, 2048) || 'unknown',
          paymentId: input.paymentId?.slice(0, 128) || null,
          orderId: input.orderId?.slice(0, 128) || null,
          requestId: input.requestId
        },
        update: {}
      })
      if (acceptance.userId !== input.userId || acceptance.context !== acceptanceContext) {
        throw createError({ statusCode: 409, message: 'Идентификатор запроса уже использован' })
      }
      rows.push(acceptance)
    }
    return { context: input.context, acceptedAt: rows[0]?.acceptedAt, documents: rows.map(row => ({ documentId: row.documentId, version: row.version, contentHash: row.contentHash })) }
  }, { isolationLevel: 'Serializable' })
}
