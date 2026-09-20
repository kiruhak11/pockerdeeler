import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { ensureLegalDocuments } from './legalService'

export const distributionCategories = ['NICKNAME', 'GAME_STATISTICS', 'ACHIEVEMENTS', 'VIRTUAL_BALANCE', 'RATING', 'WIN_HISTORY'] as const
export type DistributionCategory = typeof distributionCategories[number]
type DbClient = Prisma.TransactionClient | typeof prisma
type LegalDocumentRow = { id: string; version: string; contentHash: string; contentPath: string | null }

const categorySet = new Set<string>(distributionCategories)

export function assertDistributionCategories(categories: unknown): DistributionCategory[] {
  if (!Array.isArray(categories)) throw createError({ statusCode: 400, message: 'Выберите категории публичности' })
  const unique = [...new Set(categories)]
  if (unique.some(category => typeof category !== 'string' || !categorySet.has(category))) throw createError({ statusCode: 400, message: 'Неизвестная категория публичности' })
  return unique as DistributionCategory[]
}

function isSerializationConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  return code === 'P2034' || code === 'P2002'
}

async function currentDistributionDocument(client: DbClient, ensureRegistry = true): Promise<LegalDocumentRow | null> {
  if (ensureRegistry) await ensureLegalDocuments(client)
  const document = await client.legalDocument.findFirst({ where: { type: 'PERSONAL_DATA_DISTRIBUTION', isActive: true, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } })
  if (!document && ensureRegistry) throw createError({ statusCode: 503, message: 'Актуальная редакция согласия на распространение данных временно недоступна' })
  return document
}

export async function getDistributionPermissionsForUsers(userIds: string[], client: DbClient = prisma, ensureRegistry = true) {
  const uniqueUserIds = [...new Set(userIds)]
  const result = new Map<string, Set<DistributionCategory>>(uniqueUserIds.map(userId => [userId, new Set<DistributionCategory>()]))
  if (!uniqueUserIds.length) return result
  const document = await currentDistributionDocument(client, ensureRegistry)
  if (!document) return result
  const rows = await client.personalDataDistributionPermission.findMany({
    where: {
      userId: { in: uniqueUserIds },
      isActive: true,
      consent: { documentId: document.id, documentVersion: document.version, revokedAt: null }
    },
    select: { userId: true, category: true }
  })
  for (const row of rows) {
    const permissions = result.get(row.userId)
    if (permissions && categorySet.has(row.category)) permissions.add(row.category as DistributionCategory)
  }
  return result
}

export async function getDistributionPermissions(userId: string) {
  const permissions = await getDistributionPermissionsForUsers([userId])
  const document = await currentDistributionDocument(prisma)
  if (!document) throw createError({ statusCode: 503, message: 'Актуальная редакция согласия на распространение данных временно недоступна' })
  return {
    documentVersion: document.version,
    publicPath: document.contentPath,
    categories: [...(permissions.get(userId) || new Set<DistributionCategory>())],
    updatedAt: (await prisma.personalDataDistributionConsent.findFirst({ where: { userId, documentId: document.id, documentVersion: document.version }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }))?.updatedAt.toISOString() || null
  }
}

export async function canDistribute(userId: string, category: DistributionCategory) {
  return (await getDistributionPermissionsForUsers([userId])).get(userId)?.has(category) === true
}

export function filterPublicUserData<T extends Record<string, unknown>>(data: T, permissions: Set<DistributionCategory>, fields: Partial<Record<keyof T, DistributionCategory>>) {
  const result = { ...data } as Partial<T>
  for (const [field, category] of Object.entries(fields) as [keyof T, DistributionCategory][]) {
    if (!permissions.has(category)) delete result[field]
  }
  return result as T
}

async function ensureDistributionAcceptance(tx: Prisma.TransactionClient, input: { userId: string; document: LegalDocumentRow; ip: string; userAgent: string }) {
  const existing = await tx.legalAcceptance.findFirst({ where: { userId: input.userId, documentId: input.document.id, version: input.document.version, context: 'PERSONAL_DATA_DISTRIBUTION' } })
  if (existing) return existing
  return tx.legalAcceptance.create({ data: {
    userId: input.userId,
    documentId: input.document.id,
    version: input.document.version,
    contentHash: input.document.contentHash,
    context: 'PERSONAL_DATA_DISTRIBUTION',
    ip: input.ip.slice(0, 64) || 'unknown',
    userAgent: input.userAgent.slice(0, 2048) || 'unknown',
    requestId: randomUUID()
  } })
}

function sameCategories(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every(category => right.has(category))
}

export async function saveDistributionPermissions(input: { userId: string; categories: unknown; ip: string; userAgent: string }) {
  const selected = new Set(assertDistributionCategories(input.categories))
  const transaction = () => prisma.$transaction(async tx => {
    const document = await currentDistributionDocument(tx)
    if (!document) throw createError({ statusCode: 503, message: 'Актуальная редакция согласия на распространение данных временно недоступна' })
    const now = new Date()
    await tx.personalDataDistributionConsent.updateMany({ where: { userId: input.userId, revokedAt: null, documentId: { not: document.id } }, data: { revokedAt: now } })
    const current = await tx.personalDataDistributionConsent.findUnique({ where: { userId_documentId_documentVersion: { userId: input.userId, documentId: document.id, documentVersion: document.version } } })
    const activeRows = await tx.personalDataDistributionPermission.findMany({ where: { userId: input.userId, isActive: true, consent: { revokedAt: null } }, select: { id: true, category: true } })
    const previous = new Set(activeRows.map(row => row.category))
    if (sameCategories(previous, selected) && (!selected.size || current?.revokedAt === null)) {
      return { documentVersion: document.version, categories: [...selected], updatedAt: current?.updatedAt.toISOString() || null }
    }

    let consent = current
    if (selected.size && !consent) {
      consent = await tx.personalDataDistributionConsent.create({ data: {
        userId: input.userId,
        documentId: document.id,
        documentVersion: document.version,
        requestId: randomUUID(),
        ip: input.ip.slice(0, 64) || 'unknown',
        userAgent: input.userAgent.slice(0, 2048) || 'unknown'
      } })
      await ensureDistributionAcceptance(tx, { userId: input.userId, document, ip: input.ip, userAgent: input.userAgent })
    }
    if (consent) await tx.personalDataDistributionConsent.update({ where: { id: consent.id }, data: { revokedAt: selected.size ? null : now, updatedAt: now } })

    for (const category of distributionCategories) {
      const shouldBeActive = selected.has(category)
      const active = await tx.personalDataDistributionPermission.findUnique({ where: { userId_category_isActive: { userId: input.userId, category, isActive: true } } })
      const inactive = await tx.personalDataDistributionPermission.findUnique({ where: { userId_category_isActive: { userId: input.userId, category, isActive: false } } })
      if (shouldBeActive) {
        if (active) {
          if (active.consentId !== consent?.id) await tx.personalDataDistributionPermission.update({ where: { id: active.id }, data: { consentId: consent!.id, revokedAt: null, updatedAt: now } })
        } else if (inactive) {
          await tx.personalDataDistributionPermission.update({ where: { id: inactive.id }, data: { consentId: consent!.id, isActive: true, revokedAt: null, updatedAt: now } })
        } else {
          await tx.personalDataDistributionPermission.create({ data: { userId: input.userId, consentId: consent!.id, category, isActive: true } })
        }
      } else if (active) {
        await tx.personalDataDistributionPermission.update({ where: { id: active.id }, data: { isActive: false, revokedAt: now, updatedAt: now } })
      }
    }
    await tx.personalDataDistributionAudit.create({ data: {
      userId: input.userId,
      consentId: consent?.id,
      documentVersion: document.version,
      action: selected.size ? (previous.size ? 'UPDATE' : 'GRANT') : 'REVOKE',
      categories: [...selected],
      ip: input.ip.slice(0, 64) || 'unknown',
      userAgent: input.userAgent.slice(0, 2048) || 'unknown'
    } })
    return { documentVersion: document.version, categories: [...selected], updatedAt: now.toISOString() }
  }, { isolationLevel: 'Serializable' })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await transaction() } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  throw createError({ statusCode: 503, message: 'Настройки публичности временно обрабатываются, повторите попытку' })
}
