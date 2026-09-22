import { createError, readBody } from 'h3'
import { z } from 'zod'
import { createAuthenticatedOnlineRoom } from '../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../utils/onlineRoomApiErrors'
import { assertOnlineRoomMutationOrigin, requireOnlineRoomUser } from '../../../utils/onlineRoomApiAuth'

const schema = z.object({
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  startingStack: z.number().int().min(0).max(1_000_000_000).optional(),
  smallBlind: z.number().int().min(1).max(1_000_000_000).optional(),
  bigBlind: z.number().int().min(1).max(1_000_000_000).optional(),
  ownerSeat: z.number().int().min(1).max(6).optional(),
  privateJoinSecret: z.string().min(1).max(128).optional()
}).strict()

export default defineEventHandler(async (event) => {
  const { userId } = await requireOnlineRoomUser(event)
  assertOnlineRoomMutationOrigin(event)
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректные настройки ONLINE комнаты' })
  try {
    return await createAuthenticatedOnlineRoom(userId, parsed.data)
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
