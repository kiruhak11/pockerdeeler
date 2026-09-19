import { z } from 'zod'
import { requireAdmin, reauthenticate } from '../../../../utils/adminAuth'
import { adminContext } from '../../../../utils/adminContext'
import { prisma } from '../../../../db/client'
import { broadcastRoomState } from '../../../../ws/roomHub'
import { getRoomState } from '../../../../services/roomService'
import { startGameByDealer, startHandByDealer, finishHandByDealer, undoLastDealerAction, revealCardsByDealer, dealerForceActionForPlayer, kickPlayerByDealer, distributePotByDealer, archiveRoomByAdmin, pauseRoomByAdmin } from '../../../../services/gameService'
export default defineEventHandler(async event => {
  const actor = await requireAdmin(event)
  const parsed = z.object({ command: z.enum(['start-game', 'start-hand', 'finish-hand', 'undo', 'reveal', 'action', 'kick', 'distribute', 'archive', 'pause', 'resume']), reason: z.string().trim().min(5).max(500), requestId: z.string().uuid(), revision: z.number().int().nonnegative(), password: z.string().max(128), playerId: z.string().uuid().optional(), handId: z.string().uuid().optional(), street: z.enum(['preflop', 'flop', 'turn', 'river']).optional(), type: z.enum(['check', 'call', 'bet', 'raise', 'fold', 'all-in']).optional(), amount: z.number().int().min(0).max(2000000000).optional(), winners: z.array(z.string().uuid()).max(12).optional() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Проверьте команду и причину' })
  const input = parsed.data
  reauthenticate(input.password, actor.passwordHash)
  const room = await prisma.room.findUnique({ where: { code: String(getRouterParam(event, 'code')).toUpperCase() } })
  if (!room) throw createError({ statusCode: 404, message: 'Комната не найдена' })
  const duplicate = await prisma.adminAudit.findUnique({ where: { requestId: input.requestId } })
  if (duplicate) {
    if (duplicate.actorId !== actor.id || duplicate.entityId !== room.id || duplicate.action !== `room.${input.command}`) throw createError({ statusCode: 409, message: 'Ключ запроса занят' })
    return { success: true, duplicate: true, state: await getRoomState(room.code) }
  }
  const auth = { roomCode: room.code, dealerSecret: '__admin__' }
  await adminContext.run({ actorId: actor.id, roomHash: room.dealerSecretHash, requestId: input.requestId, reason: input.reason, command: input.command, revision: input.revision }, async () => {
    switch (input.command) {
      case 'start-game': return startGameByDealer(auth)
      case 'start-hand': return startHandByDealer(auth)
      case 'finish-hand': return finishHandByDealer(auth)
      case 'undo': return undoLastDealerAction(auth)
      case 'archive': return archiveRoomByAdmin(auth)
      case 'pause': case 'resume': return pauseRoomByAdmin({ ...auth, paused: input.command === 'pause' })
      case 'reveal': if (input.handId && input.street) return revealCardsByDealer({ ...auth, handId: input.handId, street: input.street }); break
      case 'action': if (input.playerId && input.type) return dealerForceActionForPlayer({ ...auth, playerId: input.playerId, type: input.type, amount: input.amount ?? 0 }); break
      case 'kick': if (input.playerId) return kickPlayerByDealer({ ...auth, playerId: input.playerId }); break
      case 'distribute': if (input.winners?.length) return distributePotByDealer({ ...auth, winners: input.winners }); break
    }
    throw createError({ statusCode: 400, message: 'Недостаточно данных команды' })
  })
  const state = await getRoomState(room.code)
  broadcastRoomState(room.code, state)
  return { success: true, state }
})
