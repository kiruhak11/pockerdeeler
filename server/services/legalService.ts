import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { legalDocumentSnapshots, type LegalDocumentSnapshot, type LegalDocumentType } from '../../app/data/legalDocuments'
import { prisma } from '../db/client'
import { getPremiumPaymentPlan, getVirtualCurrencyPackage } from './paymentCatalog'

export const legalAcceptanceContexts = ['PREMIUM', 'VIRTUAL_CHIPS', 'PERSONAL_DATA'] as const
export type LegalAcceptanceContext = typeof legalAcceptanceContexts[number]

const requiredTypes: Record<LegalAcceptanceContext, LegalDocumentType[]> = {
  PREMIUM: ['PUBLIC_OFFER'],
  VIRTUAL_CHIPS: ['PUBLIC_OFFER', 'VIRTUAL_CHIPS_RULES', 'GAME_RULES', 'VIRTUAL_CURRENCY_NOTICE', 'AGE_CONFIRMATION'],
  PERSONAL_DATA: ['PERSONAL_DATA_CONSENT']
}

export type LegalConfirmationInput = {
  termsAccepted?: boolean
  privacyAcknowledged?: boolean
  virtualCurrencyAcknowledged?: boolean
  virtualChipsRulesAccepted?: boolean
  ageConfirmed?: boolean
  personalDataConsent?: boolean
}

export type RegistrationLegalConfirmationInput = {
  termsAccepted?: boolean
  privacyAcknowledged?: boolean
  ageConfirmed?: boolean
  personalDataConsent?: boolean
}

const registrationRequiredTypes: LegalDocumentType[] = ['USER_AGREEMENT', 'PRIVACY_POLICY', 'PERSONAL_DATA_CONSENT', 'AGE_CONFIRMATION']

/** Seed the registration registry before opening the account-creation transaction. */
export async function ensureRegistrationLegalDocuments() {
  await ensureLegalDocuments(prisma, registrationRequiredTypes)
}

export type LegalAcceptanceInput = {
  userId: string
  context: LegalAcceptanceContext
  confirmations: LegalConfirmationInput
  requestId?: string
  productKey?: string
  checkout?: boolean
  ip: string
  userAgent: string
  paymentId?: string | null
  orderId?: string | null
}

export function legalContentHash(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function isUniqueConstraint(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002'
}

type LegalDocumentSnapshotRow = {
  type: string
  version: string
  title: string
  content: string
  contentPath: string | null
  contentHash: string
}

export function assertLegalDocumentSnapshot(row: LegalDocumentSnapshotRow, snapshot: LegalDocumentSnapshot) {
  const contentHash = legalContentHash(snapshot.content)
  if (row.contentHash !== contentHash || row.content !== snapshot.content || row.title !== snapshot.title || row.contentPath !== snapshot.publicPath) {
    throw createError({ statusCode: 500, message: `Редакция ${snapshot.type} ${snapshot.version} уже опубликована с другим содержанием. Создайте новую версию.` })
  }
}

export function assertLegalConfirmations(context: LegalAcceptanceContext, input: LegalConfirmationInput) {
  if ((context === 'PREMIUM' || context === 'VIRTUAL_CHIPS') && input.termsAccepted !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите принятие Публичной оферты и Правил сервиса' })
  }
  if (context === 'VIRTUAL_CHIPS' && input.virtualCurrencyAcknowledged !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите условия использования виртуальных фишек' })
  }
  if (context === 'VIRTUAL_CHIPS' && input.virtualChipsRulesAccepted !== true) {
    throw createError({ statusCode: 400, message: 'Примите Правила виртуальных фишек' })
  }
  if (context === 'VIRTUAL_CHIPS' && input.ageConfirmed !== true) {
    throw createError({ statusCode: 400, message: 'Подтвердите, что вам исполнилось 18 лет' })
  }
  if (context === 'PERSONAL_DATA' && input.personalDataConsent !== true) {
    throw createError({ statusCode: 400, message: 'Дайте отдельное согласие на обработку персональных данных' })
  }
}

export function assertRegistrationLegalConfirmations(input: RegistrationLegalConfirmationInput) {
  if (input.ageConfirmed !== true) throw createError({ statusCode: 400, message: 'Подтвердите, что вам исполнилось 18 лет' })
  if (input.termsAccepted !== true) throw createError({ statusCode: 400, message: 'Примите Пользовательское соглашение' })
  if (input.privacyAcknowledged !== true) throw createError({ statusCode: 400, message: 'Подтвердите ознакомление с Политикой конфиденциальности' })
  if (input.personalDataConsent !== true) throw createError({ statusCode: 400, message: 'Дайте отдельное согласие на обработку персональных данных' })
}

export async function ensureLegalDocuments(client: Prisma.TransactionClient | typeof prisma = prisma, requestedTypes?: readonly LegalDocumentType[]) {
  const idsByType = new Map<LegalDocumentType, string>()
  const now = Date.now()
  const snapshots = requestedTypes ? legalDocumentSnapshots.filter(snapshot => requestedTypes.includes(snapshot.type)) : legalDocumentSnapshots

  for (const snapshot of snapshots) {
    const contentHash = legalContentHash(snapshot.content)
    let row
    try {
      row = await client.legalDocument.upsert({
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
    } catch (error) {
      // A standalone client can recover by reading the winner. A transaction
      // cannot continue after PostgreSQL rejected its statement, so let the
      // outer transaction retry instead of issuing a query in the aborted tx.
      if (!isUniqueConstraint(error)) throw error
      if (client !== prisma) throw error
      row = await client.legalDocument.findUniqueOrThrow({ where: { type_version: { type: snapshot.type, version: snapshot.version } } })
    }
    assertLegalDocumentSnapshot(row, snapshot)
    if (new Date(snapshot.effectiveFrom).getTime() <= now) {
      const selected = snapshots
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

async function assertRequestOwnership(tx: Prisma.TransactionClient, requestId: string, userId: string, context: LegalAcceptanceContext) {
  const existing = await tx.legalAcceptance.findMany({ where: { requestId }, select: { userId: true, context: true } })
  if (existing.some(row => row.userId !== userId)) throw createError({ statusCode: 409, message: 'Идентификатор запроса принадлежит другому пользователю' })
  if (existing.some(row => row.context !== context && !(context !== 'PERSONAL_DATA' && row.context === 'PERSONAL_DATA'))) {
    throw createError({ statusCode: 409, message: 'Идентификатор запроса уже использован в другом контексте' })
  }
}

async function ensureCheckoutSession(tx: Prisma.TransactionClient, input: { userId: string; context: LegalAcceptanceContext; requestId?: string; productKey?: string }) {
  if (input.requestId) {
    const session = await tx.legalCheckoutSession.findUnique({ where: { id: input.requestId } })
    if (!session) throw createError({ statusCode: 409, message: 'Checkout не найден или уже недоступен' })
    if (session.userId !== input.userId) throw createError({ statusCode: 403, message: 'Checkout принадлежит другому пользователю' })
    if (session.context !== input.context) throw createError({ statusCode: 409, message: 'Контекст checkout не совпадает' })
    if (input.productKey) {
      const product = input.context === 'VIRTUAL_CHIPS' ? getVirtualCurrencyPackage(input.productKey) : input.context === 'PREMIUM' ? getPremiumPaymentPlan(input.productKey) : null
      const expectedPaymentType = input.context === 'VIRTUAL_CHIPS' ? 'VIRTUAL_CURRENCY' : input.context === 'PREMIUM' ? 'PREMIUM' : null
      const expectedProductKey = product ? ('packageId' in product ? product.packageId : product.plan) : null
      if (!product || !expectedPaymentType || !expectedProductKey) throw createError({ statusCode: 400, message: 'Товар checkout не найден' })
      if (session.paymentType && session.paymentType !== expectedPaymentType) throw createError({ statusCode: 409, message: 'Checkout уже связан с другим продуктом' })
      if (session.productKey && session.productKey !== expectedProductKey) throw createError({ statusCode: 409, message: 'Checkout уже связан с другим товаром' })
      if (!session.paymentType || !session.productKey) {
        return tx.legalCheckoutSession.update({ where: { id: session.id }, data: { paymentType: expectedPaymentType, productKey: expectedProductKey } })
      }
    }
    return session
  }
  const product = input.context === 'VIRTUAL_CHIPS' && input.productKey ? getVirtualCurrencyPackage(input.productKey) : input.context === 'PREMIUM' && input.productKey ? getPremiumPaymentPlan(input.productKey) : null
  if (input.productKey && !product) throw createError({ statusCode: 400, message: 'Товар checkout не найден' })
  const paymentType = input.context === 'VIRTUAL_CHIPS' && product ? 'VIRTUAL_CURRENCY' : input.context === 'PREMIUM' && product ? 'PREMIUM' : undefined
  const productKey = product ? ('packageId' in product ? product.packageId : product.plan) : undefined
  return tx.legalCheckoutSession.create({ data: { userId: input.userId, context: input.context, paymentType, productKey } })
}

function isSerializationConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  const meta = 'meta' in error && error.meta && typeof error.meta === 'object' ? error.meta as { code?: string; message?: string } : undefined
  return code === 'P2034' || code === 'P2002' || (code === 'P2010' && meta?.code === '40001') || meta?.message?.includes('could not serialize access') === true
}

async function lockLegalAcceptanceRequest(tx: Prisma.TransactionClient, requestId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('legal-acceptance:' || ${requestId}, 0))::text AS locked`
}

export async function acceptCurrentLegalDocuments(input: LegalAcceptanceInput) {
  assertLegalConfirmations(input.context, input.confirmations)
  // The registry is append-only and is shared by every checkout. Initialize
  // it before the Serializable acceptance transaction so parallel checkouts
  // do not contend on the same upsert/update statements.
  await ensureLegalDocuments()
  const transaction = () => prisma.$transaction(async tx => {
    // Serialize all uses of an explicit acceptance id across app instances.
    // The lock protects the ownership check below; the unique
    // (requestId, documentId) key then makes a same-owner retry idempotent.
    // ReadCommitted is intentional here: after waiting for this lock, each
    // statement must see the transaction that released it.
    if (input.requestId) {
      await lockLegalAcceptanceRequest(tx, input.requestId)
    }
    const requestId = input.checkout
      ? (await ensureCheckoutSession(tx, { userId: input.userId, context: input.context, requestId: input.requestId, productKey: input.productKey })).id
      : (input.requestId || randomUUID())
    if (!input.checkout && input.requestId && await tx.legalCheckoutSession.findUnique({ where: { id: input.requestId }, select: { id: true } })) {
      throw createError({ statusCode: 409, message: 'Checkout acceptance требует checkout-контекст' })
    }
    await assertRequestOwnership(tx, requestId, input.userId, input.context)
    const types = [...requiredTypes[input.context]]
    if (input.context !== 'PERSONAL_DATA' && input.confirmations.personalDataConsent === true) types.push('PERSONAL_DATA_CONSENT')
    const documents = await tx.legalDocument.findMany({ where: { type: { in: types }, isActive: true, effectiveFrom: { lte: new Date() } } })
    if (documents.length !== types.length) throw createError({ statusCode: 503, message: 'Актуальные юридические документы временно недоступны' })
    const rows = []
    for (const document of documents) {
      const acceptanceContext: LegalAcceptanceContext = document.type === 'PERSONAL_DATA_CONSENT' ? 'PERSONAL_DATA' : input.context
      const acceptance = await tx.legalAcceptance.upsert({
        where: { requestId_documentId: { requestId, documentId: document.id } },
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
          requestId
        },
        update: {}
      })
      if (acceptance.userId !== input.userId || acceptance.context !== acceptanceContext) {
        throw createError({ statusCode: 409, message: 'Идентификатор запроса уже использован' })
      }
      rows.push(acceptance)
    }
    return { context: input.context, requestId, checkout: input.checkout === true, acceptedAt: rows[0]?.acceptedAt, documents: rows.map(row => ({ documentId: row.documentId, version: row.version, contentHash: row.contentHash })) }
  }, { isolationLevel: 'ReadCommitted' })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await transaction()
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  throw createError({ statusCode: 503, message: 'Юридическое согласие временно обрабатывается, повторите попытку' })
}

export async function acceptRegistrationLegalDocuments(tx: Prisma.TransactionClient, input: {
  userId: string
  requestId: string
  confirmations: RegistrationLegalConfirmationInput
  ip: string
  userAgent: string
}) {
  assertRegistrationLegalConfirmations(input.confirmations)
  // The caller seeds the registry before opening its transaction. Never issue
  // a global Prisma query here: registration already holds the transaction
  // connection, which can be the only connection available through PgBouncer.
  await lockLegalAcceptanceRequest(tx, input.requestId)
  await ensureLegalDocuments(tx, registrationRequiredTypes)
  const existing = await tx.legalAcceptance.findMany({ where: { requestId: input.requestId }, select: { userId: true, context: true } })
  if (existing.some(row => row.userId !== input.userId)) throw createError({ statusCode: 409, message: 'Идентификатор запроса принадлежит другому пользователю' })
  if (existing.some(row => row.context !== 'REGISTRATION')) throw createError({ statusCode: 409, message: 'Идентификатор запроса уже использован в другом контексте' })

  const documents = await tx.legalDocument.findMany({ where: { type: { in: registrationRequiredTypes }, isActive: true, effectiveFrom: { lte: new Date() } } })
  if (documents.length !== registrationRequiredTypes.length) throw createError({ statusCode: 503, message: 'Актуальные юридические документы временно недоступны' })

  const rows = []
  for (const document of documents) {
    const acceptance = await tx.legalAcceptance.upsert({
      where: { requestId_documentId: { requestId: input.requestId, documentId: document.id } },
      create: {
        userId: input.userId,
        documentId: document.id,
        version: document.version,
        contentHash: document.contentHash,
        context: 'REGISTRATION',
        ip: input.ip.slice(0, 64) || 'unknown',
        userAgent: input.userAgent.slice(0, 2048) || 'unknown',
        requestId: input.requestId
      },
      update: {}
    })
    if (acceptance.userId !== input.userId || acceptance.context !== 'REGISTRATION') throw createError({ statusCode: 409, message: 'Идентификатор запроса уже использован' })
    rows.push(acceptance)
  }
  return { context: 'REGISTRATION' as const, requestId: input.requestId, acceptedAt: rows[0]?.acceptedAt, documents: rows.map(row => ({ documentId: row.documentId, version: row.version, contentHash: row.contentHash })) }
}

export async function assertCheckoutLegalAccepted(userId: string, context: LegalAcceptanceContext, requestId: string) {
  const session = await prisma.legalCheckoutSession.findUnique({ where: { id: requestId } })
  if (!session) throw createError({ statusCode: 409, message: 'Checkout не найден' })
  if (session.userId !== userId) throw createError({ statusCode: 403, message: 'Checkout принадлежит другому пользователю' })
  if (session.context !== context) throw createError({ statusCode: 409, message: 'Контекст checkout не совпадает с платежом' })
  const documents = await currentLegalDocuments(context)
  const accepted = await prisma.legalAcceptance.findMany({ where: { userId, requestId, documentId: { in: documents.map(document => document.id) }, context }, select: { documentId: true, version: true, contentHash: true } })
  const acceptedByDocument = new Map(accepted.map(row => [row.documentId, row]))
  const missing = documents.filter(document => !acceptedByDocument.has(document.id) || acceptedByDocument.get(document.id)?.version !== document.version || acceptedByDocument.get(document.id)?.contentHash !== document.contentHash)
  if (missing.length) throw createError({ statusCode: 409, message: 'Перед оплатой примите актуальные юридические документы', data: { missing: missing.map(document => ({ type: document.type, version: document.version, publicPath: document.publicPath })) } })
  return documents
}
