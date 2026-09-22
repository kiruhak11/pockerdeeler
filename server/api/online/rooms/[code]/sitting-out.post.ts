import { createError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { setAuthenticatedOnlineRoomSittingOut } from '../../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../../utils/onlineRoomApiErrors'
import { assertOnlineRoomMutationOrigin, requireOnlineRoomUser } from '../../../../utils/onlineRoomApiAuth'

const schema = z.object({
  concurrencyToken: z.string().min(32).max(2048),
  expectedRoomVersion: z.number().int().min(0).optional(),
  sittingOut: z.boolean()
}).strict()

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код ONLINE комнаты обязателен' })
  const { userId } = await requireOnlineRoomUser(event)
  assertOnlineRoomMutationOrigin(event)
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректное состояние sitting out' })
  try {
    return await setAuthenticatedOnlineRoomSittingOut(userId, code, parsed.data)
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
