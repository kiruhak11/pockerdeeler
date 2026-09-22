import { createError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { joinAuthenticatedOnlineRoom } from '../../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../../utils/onlineRoomApiErrors'
import { assertOnlineRoomMutationOrigin, requireOnlineRoomUser } from '../../../../utils/onlineRoomApiAuth'

const schema = z.object({
  concurrencyToken: z.string().min(32).max(2048),
  expectedRoomVersion: z.number().int().min(0).optional(),
  stack: z.number().int().min(0).max(1_000_000_000).optional(),
  seat: z.number().int().min(1).max(6).optional(),
  joinSecret: z.string().min(1).max(128).optional()
}).strict()

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код ONLINE комнаты обязателен' })
  const { userId } = await requireOnlineRoomUser(event)
  assertOnlineRoomMutationOrigin(event)
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Некорректные данные присоединения' })
  try {
    return await joinAuthenticatedOnlineRoom(userId, code, parsed.data)
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
