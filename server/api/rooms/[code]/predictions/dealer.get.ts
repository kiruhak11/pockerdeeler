import { getDealerPredictionState } from '../../../../services/predictionService'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const secret = getHeader(event, 'authorization')?.replace(/^Bearer /i, '') || ''
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  setHeader(event, 'Cache-Control', 'no-store')
  return getDealerPredictionState(code, secret)
})
