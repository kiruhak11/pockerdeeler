import { z } from 'zod'
import { listRoomChatMessages } from '../../../services/socialService'
import { assertRateLimit } from '../../../utils/rateLimit'

const querySchema = z.object({
  before: z.string().uuid().optional(),
  after: z.string().uuid().optional(),
  check: z.string().max(2220).transform(value => value.split(',')).pipe(z.array(z.string().uuid()).min(1).max(60)).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(40)
}).refine(value => !(value.before && value.after), 'Выберите одно направление истории')

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  assertRateLimit(event, 'room-chat-history', { limit: 180 })
  const code = getRouterParam(event, 'code')?.toUpperCase()
  if (!code) throw createError({ statusCode: 400, statusMessage: 'Код комнаты обязателен' })
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректная страница чата' })
  return listRoomChatMessages({
    roomCode: code,
    token: getHeader(event, 'authorization')?.replace(/^Bearer /i, '') || '',
    ...parsed.data
  })
})
