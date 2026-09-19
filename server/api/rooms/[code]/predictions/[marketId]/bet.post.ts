import { readBody } from 'h3'
import { placePredictionBet } from '../../../../../services/predictionService'
import { predictionBetSchema } from '../../../../../utils/validation'
import { getRoomState } from '../../../../../services/roomService'
import { broadcastRoomState } from '../../../../../ws/roomHub'
import { assertRateLimit } from '../../../../../utils/rateLimit'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const marketId = getRouterParam(event, 'marketId')
  if (!code || !marketId) throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных' })
  const parsed = predictionBetSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Некорректный прогноз' })
  assertRateLimit(event, 'prediction-bet', { limit: 30, subject: `${code}:${parsed.data.memberId}` })
  const result = await placePredictionBet({ roomCode: code, marketId, ...parsed.data })
  const roomState = await getRoomState(code)
  broadcastRoomState(code, roomState)
  return { success: true, ...result }
})
