import { createError, getRouterParam, readBody } from 'h3'
import { z } from 'zod'
import { changeAuthenticatedOnlineStack } from '../../../../services/onlineRoomApiService'
import { throwOnlineRoomApiError } from '../../../../utils/onlineRoomApiErrors'
import { assertOnlineRoomMutationOrigin, requireOnlineRoomUser } from '../../../../utils/onlineRoomApiAuth'

const schema = z.object({
  direction: z.enum(['ADD', 'WITHDRAW']),
  amount: z.number().int().positive().safe(),
  requestKey: z.string().uuid()
}).strict()

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код ONLINE комнаты обязателен' })
  const { userId } = await requireOnlineRoomUser(event)
  assertOnlineRoomMutationOrigin(event)
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная операция со стеком' })
  try {
    return await changeAuthenticatedOnlineStack(userId, code, parsed.data)
  } catch (error) {
    throwOnlineRoomApiError(error)
  }
})
