import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { blackjackActionSchema, blackjackStartSchema, type BlackjackActionInput, type BlackjackStartInput } from '../utils/blackjackValidation'
import { blackjackHandValue, blackjackPayout, createBlackjackDeck, playDealerHand, resolveBlackjackOutcome, resolveInitialBlackjack, type BlackjackCard, type BlackjackOutcome } from '../utils/blackjack'
import { verifyUserAuthToken } from './userAccountService'
import { adjustUserWallet, lockUserWallet } from './walletService'

type Tx = Prisma.TransactionClient
type Round = Prisma.BlackjackRoundGetPayload<Record<string, never>>

function jsonCards(value: Prisma.JsonValue): BlackjackCard[] {
  if (!Array.isArray(value)) throw createError({ statusCode: 500, statusMessage: 'Состояние Blackjack повреждено' })
  return value as unknown as BlackjackCard[]
}

async function authenticatedUser(token?: string | null): Promise<string> {
  const user = token ? await verifyUserAuthToken(token) : null
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  return user.userId
}

async function stateView(tx: Tx, round: Round) {
  const [wallet, playerCards, dealerCards] = await Promise.all([
    tx.userWallet.findUniqueOrThrow({ where: { userId: round.userId }, select: { balance: true } }),
    Promise.resolve(jsonCards(round.playerCards)),
    Promise.resolve(jsonCards(round.dealerCards))
  ])
  const visibleDealer = round.dealerHoleHidden ? dealerCards.slice(0, 1) : dealerCards
  const visibleDealerValue = blackjackHandValue(visibleDealer)
  return {
    roundId: round.id,
    status: round.status,
    stake: Number(round.stake),
    playerCards,
    dealerCards: round.dealerHoleHidden ? [...visibleDealer, { hidden: true as const }] : dealerCards,
    playerTotal: round.playerTotal,
    dealerTotal: round.dealerHoleHidden ? visibleDealerValue.total : round.dealerTotal,
    dealerSoft: round.dealerHoleHidden ? visibleDealerValue.soft : round.dealerSoft,
    dealerHoleHidden: round.dealerHoleHidden,
    outcome: round.outcome,
    payout: Number(round.payout),
    netChange: Number(round.payout - round.stake),
    balance: Number(wallet.balance),
    createdAt: round.createdAt.toISOString(),
    settledAt: round.settledAt?.toISOString() ?? null
  }
}

async function finishRound(tx: Tx, round: Round, input: {
  playerCards: BlackjackCard[]
  dealerCards: BlackjackCard[]
  nextCard: number
  outcome: BlackjackOutcome
  playerTotal?: number
  dealerTotal?: number
  dealerSoft?: boolean
}) {
  const payout = blackjackPayout(input.outcome, round.stake)
  const updated = await tx.blackjackRound.update({
    where: { id: round.id },
    data: {
      status: 'FINISHED',
      playerCards: input.playerCards as unknown as Prisma.InputJsonValue,
      dealerCards: input.dealerCards as unknown as Prisma.InputJsonValue,
      nextCard: input.nextCard,
      playerTotal: input.playerTotal ?? blackjackHandValue(input.playerCards).total,
      dealerTotal: input.dealerTotal ?? blackjackHandValue(input.dealerCards).total,
      dealerSoft: input.dealerSoft ?? blackjackHandValue(input.dealerCards).soft,
      dealerHoleHidden: false,
      outcome: input.outcome,
      payout,
      settledAt: new Date()
    }
  })
  if (payout > 0n) {
    await adjustUserWallet(tx, {
      userId: round.userId,
      delta: payout,
      entryType: input.outcome === 'PUSH' ? 'BLACKJACK_PUSH_REFUND' : 'BLACKJACK_PAYOUT',
      transferId: round.id,
      idempotencyKey: `blackjack:settlement:${round.id}`,
      metadata: { roundId: round.id, outcome: input.outcome, stake: Number(round.stake), grossPayout: Number(payout) }
    })
  }
  return updated
}

export async function getBlackjackState(token?: string | null) {
  const userId = await authenticatedUser(token)
  const [round, wallet] = await Promise.all([
    prisma.blackjackRound.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } })
      .then(active => active ?? prisma.blackjackRound.findFirst({ where: { userId, status: 'FINISHED' }, orderBy: { createdAt: 'desc' } })),
    prisma.userWallet.findUniqueOrThrow({ where: { userId }, select: { balance: true } })
  ])
  return { round: round ? await stateView(prisma, round) : null, balance: Number(wallet.balance) }
}

export async function startBlackjack(token: string | null | undefined, input: BlackjackStartInput) {
  const userId = await authenticatedUser(token)
  const parsed = blackjackStartSchema.safeParse(input)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Ставка должна быть чётной и не меньше 2 фишек' })
  const start = parsed.data
  return prisma.$transaction(async tx => {
    const wallet = await lockUserWallet(tx, userId)
    const idempotencyKey = `blackjack:start:${userId}:${start.requestId}`
    const duplicate = await tx.blackjackRound.findUnique({ where: { idempotencyKey } })
    if (duplicate) {
      if (duplicate.stake !== BigInt(start.stake)) throw createError({ statusCode: 409, statusMessage: 'Повторный запрос изменён' })
      return { round: await stateView(tx, duplicate) }
    }
    const active = await tx.blackjackRound.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } })
    if (active) throw createError({ statusCode: 409, statusMessage: 'Сначала завершите текущую раздачу' })
    if (wallet.balance < BigInt(start.stake)) {
      throw createError({ statusCode: 409, statusMessage: 'Недостаточно фишек на балансе' })
    }

    const shoe = createBlackjackDeck()
    const playerCards = [shoe[0]!, shoe[2]!]
    const dealerCards = [shoe[1]!, shoe[3]!]
    const playerValue = blackjackHandValue(playerCards)
    const dealerValue = blackjackHandValue(dealerCards)
    const round = await tx.blackjackRound.create({ data: {
      userId,
      status: 'ACTIVE',
      stake: BigInt(start.stake),
      playerCards: playerCards as unknown as Prisma.InputJsonValue,
      dealerCards: dealerCards as unknown as Prisma.InputJsonValue,
      shoe: shoe as unknown as Prisma.InputJsonValue,
      nextCard: 4,
      playerTotal: playerValue.total,
      dealerTotal: dealerValue.total,
      dealerSoft: dealerValue.soft,
      dealerHoleHidden: true,
      idempotencyKey
    } })
    await adjustUserWallet(tx, {
      userId,
      delta: -BigInt(start.stake),
      entryType: 'BLACKJACK_STAKE',
      transferId: round.id,
      idempotencyKey: `blackjack:stake:${round.id}`,
      metadata: { roundId: round.id, stake: start.stake }
    })
    const outcome = resolveInitialBlackjack(playerCards, dealerCards)
    const finalRound = outcome
      ? await finishRound(tx, round, { playerCards, dealerCards, nextCard: 4, outcome })
      : round
    return { round: await stateView(tx, finalRound) }
  }, { maxWait: 10_000, timeout: 15_000 })
}

async function applyAction(token: string | null | undefined, raw: BlackjackActionInput, action: 'HIT' | 'STAND') {
  const userId = await authenticatedUser(token)
  const parsed = blackjackActionSchema.safeParse(raw)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный запрос действия' })
  const input = parsed.data
  return prisma.$transaction(async tx => {
    await lockUserWallet(tx, userId)
    await tx.$queryRaw`SELECT id FROM blackjack_rounds WHERE id = CAST(${input.roundId} AS uuid) AND user_id = CAST(${userId} AS uuid) FOR UPDATE`
    const round = await tx.blackjackRound.findFirst({ where: { id: input.roundId, userId } })
    if (!round) throw createError({ statusCode: 404, statusMessage: 'Раздача не найдена' })
    const duplicate = await tx.blackjackAction.findUnique({ where: { roundId_requestId: { roundId: round.id, requestId: input.requestId } } })
    if (duplicate) {
      if (duplicate.action !== action) throw createError({ statusCode: 409, statusMessage: 'Ключ действия уже использован' })
      return { round: await stateView(tx, round), replayed: true }
    }
    if (round.status !== 'ACTIVE') throw createError({ statusCode: 409, statusMessage: 'Раздача уже завершена' })
    const playerCards = jsonCards(round.playerCards)
    let dealerCards = jsonCards(round.dealerCards)
    const shoe = jsonCards(round.shoe)
    let nextCard = round.nextCard
    const draw = () => {
      const card = shoe[nextCard]
      if (!card) throw createError({ statusCode: 500, statusMessage: 'В колоде закончились карты' })
      nextCard += 1
      return card
    }

    let updated: Round
    if (action === 'HIT') {
      playerCards.push(draw())
      const playerValue = blackjackHandValue(playerCards)
      if (playerValue.bust) {
        updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: 'LOSE', playerTotal: playerValue.total })
      } else if (playerValue.total === 21) {
        dealerCards = playDealerHand(dealerCards, draw)
        const dealerValue = blackjackHandValue(dealerCards)
        updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: resolveBlackjackOutcome(playerCards, dealerCards), playerTotal: playerValue.total, dealerTotal: dealerValue.total, dealerSoft: dealerValue.soft })
      } else {
        updated = await tx.blackjackRound.update({ where: { id: round.id }, data: { playerCards: playerCards as unknown as Prisma.InputJsonValue, nextCard, playerTotal: playerValue.total } })
      }
    } else {
      dealerCards = playDealerHand(dealerCards, draw)
      const dealerValue = blackjackHandValue(dealerCards)
      updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: resolveBlackjackOutcome(playerCards, dealerCards), dealerTotal: dealerValue.total, dealerSoft: dealerValue.soft })
    }
    await tx.blackjackAction.create({ data: { roundId: round.id, requestId: input.requestId, action } })
    return { round: await stateView(tx, updated), replayed: false }
  }, { maxWait: 10_000, timeout: 15_000 })
}

export function hitBlackjack(token: string | null | undefined, input: BlackjackActionInput) {
  return applyAction(token, input, 'HIT')
}

export function standBlackjack(token: string | null | undefined, input: BlackjackActionInput) {
  return applyAction(token, input, 'STAND')
}
