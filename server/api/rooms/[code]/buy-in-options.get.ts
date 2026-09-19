import { getBuyInOptions } from '../../../services/roomService'

export default defineEventHandler(async event => {
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const token = getHeader(event, 'authorization')?.replace(/^Bearer /i, '') || ''
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  return getBuyInOptions(code, token)
})
