import { getPredictionViewerState } from '../../../../services/predictionService'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const token = getHeader(event, 'authorization')?.replace(/^Bearer /i, '') || ''
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  setHeader(event, 'Cache-Control', 'no-store')
  return getPredictionViewerState(code, token)
})
