import { readBody } from 'h3'
import { resolveMemberEntryByDealer } from '../../../../../services/roomService'
import { memberDecisionSchema } from '../../../../../utils/validation'
import { broadcastRoomState } from '../../../../../ws/roomHub'
import { assertRateLimit } from '../../../../../utils/rateLimit'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const memberId = getRouterParam(event, 'memberId')
  if (!code || !memberId) throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных' })
  const parsed = memberDecisionSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Некорректный запрос' })
  assertRateLimit(event, 'member-decision', { limit: 60, subject: `${code}:${memberId}` })
  const state = await resolveMemberEntryByDealer({ roomCode: code, memberId, ...parsed.data })
  broadcastRoomState(code, state)
  return { success: true, state }
})
