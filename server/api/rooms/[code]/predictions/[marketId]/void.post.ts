import { readBody } from 'h3'
import { voidPredictionMarketByDealer } from '../../../../../services/predictionService'
import { getRoomState } from '../../../../../services/roomService'
import { predictionVoidSchema } from '../../../../../utils/validation'
import { broadcastRoomState } from '../../../../../ws/roomHub'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const marketId = getRouterParam(event, 'marketId')
  if (!code || !marketId) throw createError({ statusCode: 400, statusMessage: 'Недостаточно данных' })
  const parsed = predictionVoidSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message || 'Укажите причину отмены' })

  await voidPredictionMarketByDealer({ roomCode: code, marketId, ...parsed.data })
  const state = await getRoomState(code)
  broadcastRoomState(code, state)
  return { success: true, state }
})
