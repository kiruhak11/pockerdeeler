import { requireAdmin } from '../../../../utils/adminAuth'
import { getRoomState } from '../../../../services/roomService'
import { prisma } from '../../../../db/client'
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const code = String(getRouterParam(event, 'code')).toUpperCase()
  const state = await getRoomState(code)
  const players = await prisma.player.findMany({ where: { roomId: state.room.id } })
  return { state, archivePreview: players.map(p => ({ name: p.name, playerId: p.id, accountId: p.userId, walletRefund: p.userId ? p.totalCommitted + (p.balanceSettled ? 0 : p.stack) : 0, guestPointsRetired: p.userId ? 0 : p.stack + p.totalCommitted })), archivePolicy: 'Отмена незавершённой раздачи и прогнозов. Ставки возвращаются внесшим их игрокам, свободные стеки аккаунтов возвращаются в кошелёк. История сохраняется; гостевые очки не переводятся в кошельки.' }
})
