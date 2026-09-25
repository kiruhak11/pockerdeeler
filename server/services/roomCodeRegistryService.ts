import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { generateOnlineRoomCode, isValidOnlineRoomCode } from '../utils/pokerOnlineRoom'

export const PERSISTENT_ROOM_TYPES = ['HOME', 'ONLINE'] as const
export type PersistentRoomType = typeof PERSISTENT_ROOM_TYPES[number]

export type RoomCodeResolution = Readonly<{
  normalizedCode: string
  roomType: PersistentRoomType
  targetId: string
}>

export type ClaimRoomCodeInput = Readonly<{
  code: string
  roomType: PersistentRoomType
  targetId: string
}>

export type CreatePersistentOnlineRoomOptions = Readonly<{
  ownerId: string
  visibility: 'PUBLIC' | 'PRIVATE'
  status?: 'WAITING' | 'CLOSED'
  maxPlayers?: 6
  privateJoinSecretHash?: string
  startingStack?: number
  roomId?: string
  createdAt?: Date
  /** Server-only test seam; production uses crypto-random online codes. */
  codeGenerator?: () => string
  maxAttempts?: number
}>

export type PersistentOnlineRoomMetadata = Readonly<{
  id: string
  roomCode: string
  visibility: 'PUBLIC' | 'PRIVATE'
  ownerId: string
  status: 'WAITING' | 'DRAINING' | 'CLOSED'
  maxPlayers: 6
  createdAt: string
  updatedAt: string
  startingStack: number
}>

function isUniqueConstraintError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002'
}

/** Normalizes the shared HOME/ONLINE namespace without changing stored HOME codes. */
export function normalizeGlobalRoomCode(value: string): string {
  if (typeof value !== 'string') throw new Error('Room code must be a string.')
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{1,8}$/.test(normalized)) {
    throw new Error('Room code must contain between 1 and 8 ASCII letters or digits.')
  }
  return normalized
}

export async function claimRoomCode(tx: Prisma.TransactionClient, input: ClaimRoomCodeInput) {
  const normalizedCode = normalizeGlobalRoomCode(input.code)
  if (!PERSISTENT_ROOM_TYPES.includes(input.roomType)) throw new Error('Unknown persistent room type.')
  if (typeof input.targetId !== 'string' || input.targetId.trim().length === 0) throw new Error('Room target id is required.')
  return tx.roomCodeRegistry.create({
    data: {
      code: normalizedCode,
      roomType: input.roomType,
      targetId: input.targetId
    }
  })
}

function mapOnlineRoom(row: {
  id: string
  roomCode: string
  visibility: string
  ownerId: string
  status: string
  maxPlayers: number
  createdAt: Date
  updatedAt: Date
  startingStack: bigint
}): PersistentOnlineRoomMetadata {
  if (row.visibility !== 'PUBLIC' && row.visibility !== 'PRIVATE') throw new Error('Stored online room has invalid visibility.')
  if (row.status !== 'WAITING' && row.status !== 'DRAINING' && row.status !== 'CLOSED') throw new Error('Stored online room has invalid status.')
  if (row.maxPlayers !== 6) throw new Error('Stored online room has invalid player limit.')
  const startingStack = Number(row.startingStack)
  if (!Number.isSafeInteger(startingStack) || startingStack < 1) throw new Error('Stored online room has invalid starting stack.')
  return Object.freeze({
    id: row.id,
    roomCode: normalizeGlobalRoomCode(row.roomCode),
    visibility: row.visibility,
    ownerId: row.ownerId,
    status: row.status,
    maxPlayers: 6,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startingStack
  })
}

/** Creates online metadata and its namespace claim in one transaction. */
export async function createPersistentOnlineRoom(options: CreatePersistentOnlineRoomOptions): Promise<PersistentOnlineRoomMetadata> {
  if (!options || typeof options.ownerId !== 'string' || options.ownerId.trim().length === 0) throw new Error('Owner id is required.')
  if (options.visibility !== 'PUBLIC' && options.visibility !== 'PRIVATE') throw new Error('Online room visibility is invalid.')
  if (options.maxPlayers !== undefined && options.maxPlayers !== 6) throw new Error('Online rooms support exactly six players.')
  if (options.privateJoinSecretHash !== undefined && options.privateJoinSecretHash.trim().length === 0) throw new Error('Private room secret hash must be non-empty.')
  if (options.visibility === 'PUBLIC' && options.privateJoinSecretHash !== undefined) throw new Error('Public rooms cannot store a private secret hash.')
  const maxAttempts = options.maxAttempts ?? 12
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 32) throw new Error('maxAttempts must be between 1 and 32.')

  const codeGenerator = options.codeGenerator ?? generateOnlineRoomCode
  const startingStack = options.startingStack ?? 1_000
  if (!Number.isSafeInteger(startingStack) || startingStack < 1 || startingStack > 1_000_000_000) throw new Error('Starting stack must be a positive safe integer.')
  const roomId = options.roomId
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = normalizeGlobalRoomCode(codeGenerator())
    if (!isValidOnlineRoomCode(candidate)) throw new Error('Online room code must use the six-character online format.')
    try {
      const created = await prisma.$transaction(async tx => {
        const row = await tx.onlineRoom.create({
          data: {
            ...(roomId ? { id: roomId } : {}),
            roomCode: candidate,
            visibility: options.visibility,
            ownerId: options.ownerId,
            status: options.status ?? 'WAITING',
            maxPlayers: 6,
            privateJoinSecretHash: options.privateJoinSecretHash,
            startingStack: BigInt(startingStack),
            ...(options.createdAt ? { createdAt: options.createdAt } : {})
          }
        })
        await claimRoomCode(tx, { code: candidate, roomType: 'ONLINE', targetId: row.id })
        return row
      })
      return mapOnlineRoom(created)
    } catch (error) {
      if (isUniqueConstraintError(error)) continue
      throw error
    }
  }

  throw new Error('Unable to claim a unique online room code.')
}

/** Resolves only normalized identity; authorization data is intentionally omitted. */
export async function resolveRoomCode(code: string): Promise<RoomCodeResolution | null> {
  const normalizedCode = normalizeGlobalRoomCode(code)
  const registry = await prisma.roomCodeRegistry.findUnique({ where: { code: normalizedCode } })
  if (!registry) return null

  if (registry.roomType === 'HOME') {
    const room = await prisma.room.findUnique({ where: { id: registry.targetId }, select: { id: true } })
    return room ? Object.freeze({ normalizedCode, roomType: 'HOME' as const, targetId: room.id }) : null
  }
  if (registry.roomType === 'ONLINE') {
    const room = await prisma.onlineRoom.findUnique({ where: { id: registry.targetId }, select: { id: true } })
    return room ? Object.freeze({ normalizedCode, roomType: 'ONLINE' as const, targetId: room.id }) : null
  }
  throw new Error('Room code registry contains an unknown room type.')
}
