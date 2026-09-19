import { z } from 'zod'
import { deleteRoomByDealer } from '../../../services/gameService'

export default defineEventHandler(async event => {
  const parsed = z.object({ dealerSecret: z.string().min(1).max(512) }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Необходим ключ дилера' })
  await deleteRoomByDealer({ roomCode: getRouterParam(event, 'code')!.toUpperCase(), dealerSecret: parsed.data.dealerSecret })
  return { success: true, roomDeleted: true }
})
