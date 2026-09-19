import { z } from 'zod'
import { revealCardsByDealer } from '../../../services/gameService'
import { broadcastRoomState } from '../../../ws/roomHub'

export default defineEventHandler(async event => {
  const parsed = z.object({ dealerSecret: z.string().min(8), handId: z.string().uuid(), street: z.enum(['preflop', 'flop', 'turn']) }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректные данные открытия карт' })
  const roomCode = getRouterParam(event, 'code')!.toUpperCase()
  const state = await revealCardsByDealer({ roomCode, ...parsed.data })
  broadcastRoomState(roomCode, state)
  return { state }
})
