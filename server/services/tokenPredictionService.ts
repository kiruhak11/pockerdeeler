import { createHash } from 'node:crypto'
import type { Hand, Player, Prisma, Room } from '@prisma/client'
import { createError } from 'h3'
import { prisma } from '../db/client'
import { verifyUserAuthToken } from './userAccountService'
import { parseRoomSettings } from './roomService'
import { adjustUserWallet, lockUserWallet, recordRoomLedger } from './walletService'
import { allocateTokenRewards } from '../utils/tokenRewards'
import { unlockAchievement } from './achievementService'
type Tx = Prisma.TransactionClient
type Candidate = { id: string; name: string; seat: number; userId: string | null }
export async function openTokenRound(tx: Tx, room: Room, hand: Hand, players: Player[]) {
  if (!parseRoomSettings(room.settings).predictions.enabled) return
  const candidates = players.filter(p => p.totalCommitted > 0 || ['active','checked','all-in'].includes(p.status)).map(p => ({ id: p.id, name: p.name, seat: p.seat, userId: p.userId }))
  await tx.tokenPredictionRound.create({ data: { roomId: room.id, handId: hand.id, handNumber: hand.handNumber, candidates } })
}
export async function lockTokenRound(tx: Tx, handId: string) {
  await tx.tokenPredictionRound.updateMany({ where: { handId, status: 'OPEN' }, data: { status: 'LOCKED', lockedAt: new Date() } })
}
export async function voidTokenRounds(tx: Tx, roomId: string, handId?: string) {
  await tx.tokenPrediction.updateMany({ where: { round: { roomId, ...(handId ? { handId } : {}), status: { in: ['OPEN','LOCKED'] } } }, data: { status: 'VOID' } })
  await tx.tokenPredictionRound.updateMany({ where: { roomId, ...(handId ? { handId } : {}), status: { in: ['OPEN','LOCKED'] } }, data: { status: 'VOID', settledAt: new Date() } })
}
async function auth(token?: string | null) {
  const result = token ? await verifyUserAuthToken(token) : null
  if (!result) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return result.userId
}
async function connected(tx: Tx, roomId: string, userId: string) {
  if (!await tx.roomParticipant.findFirst({ where: { roomId, userId, role: { in: ['player','spectator'] }, isConnected: true } })) throw createError({ statusCode: 403, statusMessage: 'Прогнозы доступны участникам комнаты' })
}
export async function setTokenPredictions(code: string, token: string | null | undefined, input: { roundId: string; requestId: string; allocations: Array<{ candidateId: string; tokens: number }> }) {
  const id = await auth(token)
  const allocations = [...input.allocations].sort((a,b) => a.candidateId.localeCompare(b.candidateId))
  if (new Set(allocations.map(a => a.candidateId)).size !== allocations.length || allocations.some(a => !Number.isInteger(a.tokens) || a.tokens < 1 || a.tokens > 3) || allocations.reduce((s,a) => s+a.tokens,0) > 3) throw createError({ statusCode: 400, statusMessage: 'На раздачу доступно ровно 3 жетона' })
  const inputHash = createHash('sha256').update(JSON.stringify(allocations)).digest('hex')
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM rooms WHERE code=${code} FOR UPDATE`
    const room = await tx.room.findUnique({ where: { code } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    await connected(tx, room.id, id)
    const round = await tx.tokenPredictionRound.findFirst({ where: { id: input.roundId, roomId: room.id } })
    if (!round) throw createError({ statusCode: 404, statusMessage: 'Прогноз не найден' })
    const duplicate = await tx.tokenPredictionCommand.findUnique({ where: { roundId_userId_requestId: { roundId: round.id, userId: id, requestId: input.requestId } } })
    if (duplicate) {
      if (duplicate.inputHash !== inputHash) throw createError({ statusCode: 409, statusMessage: 'Повторный запрос изменён' })
      return
    }
    const hand = await tx.hand.findUnique({ where: { id: round.handId } })
    if (round.status !== 'OPEN' || room.status !== 'active' || !parseRoomSettings(room.settings).predictions.enabled || hand?.status !== 'active' || (hand.bettingState as { phase?: string } | null)?.phase !== 'betting' || await tx.playerAction.count({ where: { handId: round.handId } })) throw createError({ statusCode: 409, statusMessage: 'Прогнозы зафиксированы с первым действием раздачи' })
    const candidates = round.candidates as unknown as Candidate[]
    for (const allocation of allocations) {
      const candidate = candidates.find(c => c.id === allocation.candidateId)
      if (!candidate || candidate.userId === id) throw createError({ statusCode: 400, statusMessage: 'Выберите другого участника раздачи' })
    }
    await tx.tokenPrediction.deleteMany({ where: { roundId: round.id, userId: id } })
    if (allocations.length) await tx.tokenPrediction.createMany({ data: allocations.map(a => ({ roundId: round.id, userId: id, candidateId: a.candidateId, tokens: a.tokens })) })
    await tx.tokenPredictionCommand.create({ data: { roundId: round.id, userId: id, requestId: input.requestId, inputHash } })
    await tx.room.update({ where: { id: room.id }, data: { revision: { increment: 1 } } })
  })
  return tokenViewerState(code, token)
}
export async function tokenViewerState(code: string, token?: string | null) {
  const id = await auth(token)
  return prisma.$transaction(async tx => {
    const room = await tx.room.findUnique({ where: { code } })
    if (!room) throw createError({ statusCode: 404, statusMessage: 'Комната не найдена' })
    await connected(tx, room.id, id)
    const round = await tx.tokenPredictionRound.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' }, include: { predictions: { where: { userId: id } } } })
    const history = await tx.tokenPrediction.findMany({ where: { userId: id, round: { roomId: room.id, status: { in: ['SETTLED','VOID'] } } }, include: { round: true }, orderBy: { round: { createdAt: 'desc' } }, take: 20 })
    const candidates = round?.candidates as unknown as Candidate[] | undefined
    const hand = round ? await tx.hand.findUnique({ where: { id: round.handId } }) : null
    const locked = round && (round.status !== 'OPEN' || hand?.status !== 'active' || await tx.playerAction.count({ where: { handId: round.handId } }) > 0)
    const available = room.status === 'active' && parseRoomSettings(room.settings).predictions.enabled && !locked
    return {
      enabled: parseRoomSettings(room.settings).predictions.enabled,
      round: round ? { id: round.id, handNumber: round.handNumber, status: locked && round.status === 'OPEN' ? 'LOCKED' : round.status, accepting: available, rewardFund: Number(round.rewardFund), candidates: candidates!.map(c => ({ id: c.id, name: c.name, seat: c.seat, available: c.userId !== id })) } : null,
      budget: 3, remaining: round && ['OPEN','LOCKED'].includes(round.status) ? 3 - round.predictions.reduce((sum,p) => sum+p.tokens,0) : 0,
      allocations: round?.predictions.map(p => ({ candidateId: p.candidateId, tokens: p.tokens, status: p.status, payout: Number(p.payout) })) || [],
      history: history.map(p => ({ id: p.id, roundId: p.roundId, handNumber: p.round.handNumber, candidateName: (p.round.candidates as unknown as Candidate[]).find(c=>c.id===p.candidateId)?.name || 'Игрок', tokens: p.tokens, status: p.status, payout: Number(p.payout), settledAt: p.round.settledAt?.toISOString() }))
    }
  }, { isolationLevel: 'RepeatableRead' })
}
export async function tokenDealerState(code: string, secret: string) {
  const { verifySecret } = await import('./authService')
  const room = await prisma.room.findUnique({ where: { code } })
  if (!room || !verifySecret(secret, room.dealerSecretHash)) throw createError({ statusCode: 403, statusMessage: 'Нет доступа к столу' })
  const round = await prisma.tokenPredictionRound.findFirst({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' }, include: { predictions: true } })
  if (!round) return { round: null }
  // Only anonymous candidate totals are exposed, including after settlement.
  return { round: { id: round.id, handNumber: round.handNumber, status: round.status, rewardFund: Number(round.rewardFund), candidates: (round.candidates as unknown as Candidate[]).map(c => ({ id: c.id, name: c.name, tokens: round.predictions.filter(p=>p.candidateId===c.id).reduce((sum,p)=>sum+p.tokens,0) })) } }
}
export async function settleTokenRound(tx: Tx, room: Room, hand: Hand, sources: Player[], distributed: Array<{ id: string; stack: number }>, winnerIds: string[]) {
  const round = await tx.tokenPredictionRound.findUnique({ where: { handId: hand.id }, include: { predictions: true } })
  if (!round || ['SETTLED','VOID'].includes(round.status)) return 0n
  const winners = distributed.map(p => {
    const source = sources.find(s=>s.id===p.id)!
    return { id: p.id, netProfit: p.stack - source.stack - source.totalCommitted }
  }).filter(p => winnerIds.includes(p.id))
  const { payouts, deductions, total } = allocateTokenRewards(winners, round.predictions.map(p => ({ id: p.id, candidateId: p.candidateId, tokens: p.tokens })))
  for (const player of distributed) player.stack -= Number(deductions.get(player.id) || 0n)
  for (const id of [...new Set(round.predictions.map(p=>p.userId))].sort()) await lockUserWallet(tx, id)
  for (const prediction of round.predictions) {
    const won = winners.some(w=>w.id===prediction.candidateId)
    const payout = payouts.get(prediction.id) || 0n
    if (payout) await adjustUserWallet(tx, { userId: prediction.userId, delta: payout, entryType: 'PREDICTION_REWARD', transferId: round.id, idempotencyKey: `token:reward:${prediction.id}`, roomId: room.id, metadata: { roundId: round.id, handId: hand.id, candidateId: prediction.candidateId, tokens: prediction.tokens, roomName: room.name, roomCode: room.code } })
    const ratingDelta = won ? 10 : -5
    await tx.predictionRatingEvent.create({ data: { userId: prediction.userId, delta: ratingDelta, reason: `token:${prediction.id}` } })
    const account = await tx.user.findUniqueOrThrow({ where: { id: prediction.userId }, select: { predictionRating: true } })
    await tx.user.update({ where: { id: prediction.userId }, data: { predictionCount: { increment: 1 }, predictionWins: { increment: won ? 1 : 0 }, predictionSplitWins: { increment: won && winners.length > 1 ? 1 : 0 }, predictionRating: Math.max(0, account.predictionRating + ratingDelta) } })
    await tx.tokenPrediction.update({ where: { id: prediction.id }, data: { status: won ? 'WON' : 'LOST', payout, ratingDelta } })
    if (won) {
      const latest = await tx.tokenPredictionRound.findMany({ where: { predictions: { some: { userId: prediction.userId, status: { in: ['WON','LOST'] } } } }, include: { predictions: { where: { userId: prediction.userId } } }, orderBy: { createdAt: 'desc' }, take: 3 })
      if (latest.length===3 && latest.every(r=>r.predictions.some(p=>p.status==='WON'))) await unlockAchievement(tx, prediction.userId, 'prediction_hat_trick')
    }
  }
  for (const [playerId, amount] of deductions) if (amount) await recordRoomLedger(tx, { roomId: room.id, transferId: round.id, accountType: 'table_stack', entryType: 'TOKEN_REWARD_FUND_DEBIT', amount: -amount, idempotencyKey: `token:fund:${round.id}:${playerId}`, metadata: { playerId, handId: hand.id } })
  await tx.tokenPredictionRound.update({ where: { id: round.id }, data: { status: 'SETTLED', rewardFund: total, deductions: Object.fromEntries([...deductions].map(([id,v])=>[id,Number(v)])), settledAt: new Date() } })
  if (total !== [...payouts.values()].reduce((sum,v)=>sum+v,0n)) throw new Error('Token payout invariant violated')
  return total
}
