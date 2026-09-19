import { readBody } from 'h3'
import { resolveReentry } from '../../../../../services/predictionService'
import { reentryDecisionSchema } from '../../../../../utils/validation'
import { getRoomState } from '../../../../../services/roomService'
import { broadcastRoomState } from '../../../../../ws/roomHub'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const requestId = getRouterParam(event, 'requestId')
  if (!code || !requestId) throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных' })
  const parsed = reentryDecisionSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Некорректный запрос' })
  await resolveReentry({ roomCode: code, requestId, ...parsed.data })
  const state = await getRoomState(code)
  broadcastRoomState(code, state)
  return { success: true, state }
})
