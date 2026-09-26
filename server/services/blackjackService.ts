import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client'
import { blackjackActionSchema, blackjackStartSchema, type BlackjackActionInput, type BlackjackStartInput } from '../utils/blackjackValidation'
import { blackjackHandValue, blackjackPayout, createBlackjackDeck, playDealerHand, resolveBlackjackOutcome, resolveInitialBlackjack, type BlackjackCard, type BlackjackOutcome } from '../utils/blackjack'
import { verifyUserAuthToken } from './userAccountService'
import { adjustUserWallet, lockUserWallet } from './walletService'

type Tx = Prisma.TransactionClient
type Round = Prisma.BlackjackRoundGetPayload<Record<string, never>>
type SplitHand = {
  cards: BlackjackCard[]
  stake: number
  total: number
  status: 'ACTIVE' | 'WAITING' | 'STOOD' | 'BUST' | 'FINISHED'
  result: 'WIN' | 'LOSE' | 'PUSH' | 'BUST' | null
  payout: number
}

function jsonHands(value: Prisma.JsonValue | null): SplitHand[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2) throw createError({ statusCode: 500, statusMessage: 'Состояние Split Blackjack повреждено' })
  return value as unknown as SplitHand[]
}

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
  const [wallet, storedPlayerCards, dealerCards, doubleAction] = await Promise.all([
    tx.userWallet.findUniqueOrThrow({ where: { userId: round.userId }, select: { balance: true } }),
    Promise.resolve(jsonCards(round.playerCards)),
    Promise.resolve(jsonCards(round.dealerCards)),
    tx.blackjackAction.findFirst({ where: { roundId: round.id, action: 'DOUBLE' }, select: { id: true } })
  ])
  const splitHands = jsonHands(round.playerHands)
  const playerCards = splitHands
    ? splitHands[round.activeHandIndex ?? 0]?.cards ?? splitHands[0]!.cards
    : storedPlayerCards
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
    doubled: Boolean(doubleAction),
    splitHands: splitHands?.map(hand => ({ ...hand, stake: Number(hand.stake), payout: Number(hand.payout) })) ?? null,
    activeHandIndex: round.activeHandIndex,
    actionRevision: round.actionRevision,
    payout: Number(round.payout),
    netChange: Number(round.payout - round.stake),
    balance: Number(wallet.balance),
    createdAt: round.createdAt.toISOString(),
    settledAt: round.settledAt?.toISOString() ?? null
  }
}

function splitHandResult(hand: SplitHand, dealerCards: BlackjackCard[]): SplitHand['result'] {
  if (hand.status === 'BUST' || blackjackHandValue(hand.cards).bust) return 'BUST'
  const playerTotal = blackjackHandValue(hand.cards).total
  const dealerValue = blackjackHandValue(dealerCards)
  if (dealerValue.bust || playerTotal > dealerValue.total) return 'WIN'
  if (playerTotal < dealerValue.total) return 'LOSE'
  return 'PUSH'
}

async function settleSplitRound(tx: Tx, round: Round, hands: SplitHand[], dealerCards: BlackjackCard[], nextCard: number) {
  const dealerValue = blackjackHandValue(dealerCards)
  let totalPayout = 0n
  const settledHands = hands.map(hand => {
    const result = splitHandResult(hand, dealerCards)
    const payout = result === 'WIN' ? BigInt(hand.stake) * 2n : result === 'PUSH' ? BigInt(hand.stake) : 0n
    totalPayout += payout
    return { ...hand, total: blackjackHandValue(hand.cards).total, status: result === 'BUST' ? 'BUST' as const : 'FINISHED' as const, result, payout: Number(payout) }
  })
  const totalStake = settledHands.reduce((sum, hand) => sum + BigInt(hand.stake), 0n)
  const aggregateOutcome: BlackjackOutcome = totalPayout > totalStake ? 'WIN' : totalPayout < totalStake ? 'LOSE' : 'PUSH'
  const updated = await tx.blackjackRound.update({
    where: { id: round.id },
    data: {
      status: 'FINISHED',
      stake: totalStake,
      actionRevision: round.actionRevision + 1,
      playerHands: settledHands as unknown as Prisma.InputJsonValue,
      activeHandIndex: null,
      playerCards: settledHands[0]!.cards as unknown as Prisma.InputJsonValue,
      playerTotal: settledHands[0]!.total,
      dealerCards: dealerCards as unknown as Prisma.InputJsonValue,
      nextCard,
      dealerTotal: dealerValue.total,
      dealerSoft: dealerValue.soft,
      dealerHoleHidden: false,
      outcome: aggregateOutcome,
      payout: totalPayout,
      settledAt: new Date()
    }
  })
  if (totalPayout > 0n) {
    await adjustUserWallet(tx, {
      userId: round.userId,
      delta: totalPayout,
      entryType: 'BLACKJACK_SPLIT_PAYOUT',
      transferId: round.id,
      idempotencyKey: `blackjack:settlement:${round.id}`,
      metadata: { roundId: round.id, split: true, hands: settledHands.map(({ result, stake, payout }) => ({ result, stake, payout })), grossPayout: Number(totalPayout) }
    })
  }
  return updated
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
      actionRevision: round.actionRevision + 1,
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

async function applyAction(token: string | null | undefined, raw: BlackjackActionInput, action: 'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT') {
  const userId = await authenticatedUser(token)
  const parsed = blackjackActionSchema.safeParse(raw)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный запрос действия' })
  const input = parsed.data
  return prisma.$transaction(async tx => {
    const wallet = await lockUserWallet(tx, userId)
    await tx.$queryRaw`SELECT id FROM blackjack_rounds WHERE id = CAST(${input.roundId} AS uuid) AND user_id = CAST(${userId} AS uuid) FOR UPDATE`
    const round = await tx.blackjackRound.findFirst({ where: { id: input.roundId, userId } })
    if (!round) throw createError({ statusCode: 404, statusMessage: 'Раздача не найдена' })
    const duplicate = await tx.blackjackAction.findUnique({ where: { roundId_requestId: { roundId: round.id, requestId: input.requestId } } })
    if (duplicate) {
      if (duplicate.action !== action) throw createError({ statusCode: 409, statusMessage: 'Ключ действия уже использован' })
      return { round: await stateView(tx, round), replayed: true }
    }
    if (input.expectedRevision !== round.actionRevision) {
      throw createError({ statusCode: 409, statusMessage: 'Состояние раздачи уже изменилось. Обновите ход.' })
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
    const existingHands = jsonHands(round.playerHands)
    if (existingHands) {
      if (action === 'DOUBLE' || action === 'SPLIT') {
        throw createError({ statusCode: 409, statusMessage: 'После Split доступны только Взять и Хватит' })
      }
      const activeHandIndex = round.activeHandIndex
      if (activeHandIndex === null) throw createError({ statusCode: 409, statusMessage: 'Нет активной руки' })
      const activeHand = existingHands[activeHandIndex]
      if (!activeHand || activeHand.status !== 'ACTIVE') throw createError({ statusCode: 409, statusMessage: 'Нет активной руки' })
      const hands = existingHands.map(hand => ({ ...hand, cards: [...hand.cards] }))
      const current = hands[activeHandIndex]!
      if (action === 'HIT') {
        current.cards.push(draw())
        current.total = blackjackHandValue(current.cards).total
        if (blackjackHandValue(current.cards).bust) current.status = 'BUST'
        else if (current.total === 21) current.status = 'STOOD'
      } else {
        current.status = 'STOOD'
      }

      const nextActiveIndex = current.status === 'ACTIVE'
        ? activeHandIndex
        : hands.findIndex((hand, index) => index > activeHandIndex && hand.status === 'WAITING')
      if (nextActiveIndex >= 0) {
        const nextHand = hands[nextActiveIndex]!
        nextHand.status = 'ACTIVE'
        updated = await tx.blackjackRound.update({
          where: { id: round.id },
          data: {
            playerHands: hands as unknown as Prisma.InputJsonValue,
            activeHandIndex: nextActiveIndex,
            actionRevision: round.actionRevision + 1,
            playerCards: nextHand.cards as unknown as Prisma.InputJsonValue,
            playerTotal: nextHand.total,
            nextCard
          }
        })
      } else {
        const allBust = hands.every(hand => hand.status === 'BUST')
        if (!allBust) dealerCards = playDealerHand(dealerCards, draw)
        updated = await settleSplitRound(tx, round, hands, dealerCards, nextCard)
      }
    } else if (action === 'SPLIT') {
      const blockedAction = await tx.blackjackAction.findFirst({ where: { roundId: round.id, action: { in: ['HIT', 'STAND', 'DOUBLE', 'SPLIT'] } }, select: { id: true } })
      if (playerCards.length !== 2 || blockedAction || playerCards[0]!.rank !== playerCards[1]!.rank) {
        throw createError({ statusCode: 409, statusMessage: 'Разделить можно только две одинаковые первые карты' })
      }
      if (round.stake <= 0n || wallet.balance < round.stake) {
        throw createError({ statusCode: 409, statusMessage: 'Недостаточно фишек для второй руки' })
      }
      const originalStake = round.stake
      await adjustUserWallet(tx, {
        userId,
        delta: -originalStake,
        entryType: 'BLACKJACK_SPLIT_STAKE',
        transferId: round.id,
        idempotencyKey: `blackjack:split:${round.id}`,
        metadata: { roundId: round.id, additionalStake: Number(originalStake) }
      })
      const firstCards = [playerCards[0]!, draw()]
      const secondCards = [playerCards[1]!, draw()]
      const aces = playerCards[0]!.rank === 'A'
      const hands: SplitHand[] = [firstCards, secondCards].map((cards, index) => ({
        cards,
        stake: Number(originalStake),
        total: blackjackHandValue(cards).total,
        status: aces ? 'STOOD' : index === 0 ? 'ACTIVE' : 'WAITING',
        result: null,
        payout: 0
      }))
      const doubledStake = originalStake * 2n
      if (aces) {
        dealerCards = playDealerHand(dealerCards, draw)
        updated = await settleSplitRound(tx, { ...round, stake: doubledStake }, hands, dealerCards, nextCard)
      } else {
        updated = await tx.blackjackRound.update({
          where: { id: round.id },
          data: {
            stake: doubledStake,
            playerHands: hands as unknown as Prisma.InputJsonValue,
            activeHandIndex: 0,
            actionRevision: round.actionRevision + 1,
            playerCards: firstCards as unknown as Prisma.InputJsonValue,
            playerTotal: hands[0]!.total,
            nextCard
          }
        })
      }
    } else if (action === 'HIT') {
      playerCards.push(draw())
      const playerValue = blackjackHandValue(playerCards)
      if (playerValue.bust) {
        updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: 'LOSE', playerTotal: playerValue.total })
      } else if (playerValue.total === 21) {
        dealerCards = playDealerHand(dealerCards, draw)
        const dealerValue = blackjackHandValue(dealerCards)
        updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: resolveBlackjackOutcome(playerCards, dealerCards), playerTotal: playerValue.total, dealerTotal: dealerValue.total, dealerSoft: dealerValue.soft })
      } else {
        updated = await tx.blackjackRound.update({ where: { id: round.id }, data: { playerCards: playerCards as unknown as Prisma.InputJsonValue, nextCard, playerTotal: playerValue.total, actionRevision: round.actionRevision + 1 } })
      }
    } else if (action === 'STAND') {
      dealerCards = playDealerHand(dealerCards, draw)
      const dealerValue = blackjackHandValue(dealerCards)
      updated = await finishRound(tx, round, { playerCards, dealerCards, nextCard, outcome: resolveBlackjackOutcome(playerCards, dealerCards), dealerTotal: dealerValue.total, dealerSoft: dealerValue.soft })
    } else {
      if (playerCards.length !== 2 || round.stake <= 0n) {
        throw createError({ statusCode: 409, statusMessage: 'Удвоение доступно только до первого добора' })
      }
      if (wallet.balance < round.stake) {
        throw createError({ statusCode: 409, statusMessage: 'Недостаточно фишек для удвоения ставки' })
      }
      const initialStake = round.stake
      await adjustUserWallet(tx, {
        userId,
        delta: -initialStake,
        entryType: 'BLACKJACK_DOUBLE_STAKE',
        transferId: round.id,
        idempotencyKey: `blackjack:double:${round.id}`,
        metadata: { roundId: round.id, additionalStake: Number(initialStake) }
      })
      const doubledRound = await tx.blackjackRound.update({ where: { id: round.id }, data: { stake: initialStake * 2n } })
      playerCards.push(draw())
      dealerCards = playDealerHand(dealerCards, draw)
      const playerValue = blackjackHandValue(playerCards)
      const dealerValue = blackjackHandValue(dealerCards)
      updated = await finishRound(tx, doubledRound, {
        playerCards, dealerCards, nextCard, outcome: resolveBlackjackOutcome(playerCards, dealerCards),
        playerTotal: playerValue.total, dealerTotal: dealerValue.total, dealerSoft: dealerValue.soft
      })
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

export function doubleBlackjack(token: string | null | undefined, input: BlackjackActionInput) {
  return applyAction(token, input, 'DOUBLE')
}

export function splitBlackjack(token: string | null | undefined, input: BlackjackActionInput) {
  return applyAction(token, input, 'SPLIT')
}
