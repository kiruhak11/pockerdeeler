import test from 'node:test'
import assert from 'node:assert/strict'
import { createSeededBotRandom, decideBotAction, roundBotDecisionToChipStep, type BotDecisionContext } from '../server/utils/pokerBotDecision'
import type { BotPlayStyle, BotSkillTier } from '../server/services/botIdentityService'
import { createShuffledDeck, type Card } from '../server/utils/pokerDeck'
import { startHand } from '../server/utils/pokerHandState'
import { applyBettingAction, getMinimumRaiseTo, getToCall } from '../server/utils/pokerBetting'

const c = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit })
const profile = (skillTier: BotSkillTier, playStyle: BotPlayStyle) => ({ skillTier, playStyle })

function context(overrides: Partial<BotDecisionContext> = {}): BotDecisionContext {
  return {
    playerId: 'bot-1',
    street: 'PREFLOP',
    holeCards: [c('A', 'spades'), c('A', 'hearts')],
    board: [],
    pot: 300,
    currentBet: 100,
    streetContribution: 0,
    toCall: 100,
    stack: 1000,
    bigBlind: 100,
    minRaiseTo: 300,
    legalActions: ['fold', 'call', 'raise', 'all-in'],
    position: 'LATE',
    ...overrides
  }
}

test('decision uses existing lowercase betting action API and player id', () => {
  const action = decideBotAction(context(), profile('STRONG', 'TIGHT_AGGRESSIVE'), createSeededBotRandom(4))
  assert.equal(action.playerId, 'bot-1')
  assert.ok(['fold', 'call', 'raise', 'all-in'].includes(action.type))
  if (action.type === 'raise') assert.ok((action.amount ?? 0) >= 300)
})

test('bot voluntary bet and raise targets use 10-chip increments without rounding calls or all-ins', () => {
  const base = context({ currentBet: 100, streetContribution: 0, stack: 1_000, minRaiseTo: 300 })
  const raise = decideBotAction(base, profile('REGULAR', 'BALANCED'), () => 0.5)
  const roundedRaise = roundBotDecisionToChipStep(base, { ...raise, type: 'raise', amount: 333 })
  assert.equal(roundedRaise.amount, 330)
  const roundedBet = roundBotDecisionToChipStep(base, { ...raise, type: 'bet', amount: 333 })
  assert.equal(roundedBet.amount, 330)
  const allIn = roundBotDecisionToChipStep(base, { ...raise, type: 'all-in', amount: 1_000 })
  assert.equal(allIn.amount, 1_000)
  const call = roundBotDecisionToChipStep(base, { ...raise, type: 'call', amount: 103 })
  assert.equal(call.amount, 103)
})

test('rounded raise remains legal and never becomes an accidental all-in', () => {
  const base = context({ currentBet: 305, streetContribution: 0, stack: 704, minRaiseTo: 500 })
  const source = decideBotAction(base, profile('REGULAR', 'BALANCED'), () => 0.5)
  const rounded = roundBotDecisionToChipStep(base, { ...source, type: 'raise', amount: 699 })
  assert.equal(rounded.amount, 700)
  assert.ok((rounded.amount ?? 0) >= 500)
  assert.ok((rounded.amount ?? 0) < 704)
})

test('check is selected when there is no call and betting is not attractive', () => {
  const action = decideBotAction(context({ currentBet: 0, toCall: 0, streetContribution: 0, legalActions: ['check', 'bet'] }), profile('STRONG', 'TIGHT_PASSIVE'), () => 0.99)
  assert.equal(action.type, 'check')
})

test('weak bot can fold a costly marginal call', () => {
  const action = decideBotAction(context({ holeCards: [c('2', 'clubs'), c('7', 'diamonds')], pot: 100, currentBet: 1000, toCall: 1000, minRaiseTo: 3000 }), profile('STRONG', 'TIGHT_PASSIVE'), () => 0.99)
  assert.equal(action.type, 'fold')
})

test('recent public all-in aggression makes a strong bot continue wider but weak bots can still fold', () => {
  const marginal = context({ holeCards: [c('K', 'clubs'), c('J', 'diamonds')], pot: 100, currentBet: 150, toCall: 150, stack: 1000, legalActions: ['fold', 'call'] })
  const cautious = decideBotAction(marginal, profile('STRONG', 'TIGHT_PASSIVE'), () => 0.9)
  const adapted = decideBotAction({ ...marginal, opponentAllInFrequency: 1 }, profile('STRONG', 'TIGHT_PASSIVE'), () => 0.9)
  assert.equal(cautious.type, 'fold')
  assert.equal(adapted.type, 'call')

  const weak = decideBotAction({ ...marginal, holeCards: [c('2', 'clubs'), c('7', 'diamonds')], opponentAllInFrequency: 1 }, profile('WEAK', 'TIGHT_PASSIVE'), () => 0.9)
  assert.equal(weak.type, 'fold')
})

test('made postflop hand is evaluated from known cards only', () => {
  const action = decideBotAction(context({ street: 'FLOP', holeCards: [c('A', 'spades'), c('A', 'hearts')], board: [c('A', 'clubs'), c('8', 'diamonds'), c('2', 'clubs')], toCall: 100, pot: 500, currentBet: 100, legalActions: ['fold', 'call', 'raise'], minRaiseTo: 300 }), profile('STRONG', 'TIGHT_AGGRESSIVE'), () => 0.01)
  assert.notEqual(action.type, 'fold')
})

test('flush and straight draws improve continuation without hidden-card access', () => {
  const draw = context({ street: 'FLOP', holeCards: [c('9', 'spades'), c('8', 'spades')], board: [c('7', 'spades'), c('2', 'spades'), c('K', 'clubs')], toCall: 100, pot: 500, legalActions: ['fold', 'call'], minRaiseTo: 300 })
  const action = decideBotAction(draw, profile('REGULAR', 'BALANCED'), () => 0.05)
  assert.ok(['call', 'fold'].includes(action.type))
})

test('bet amount is a legal final street contribution', () => {
  const action = decideBotAction(context({ currentBet: 0, toCall: 0, streetContribution: 0, pot: 400, stack: 800, legalActions: ['check', 'bet'] }), profile('REGULAR', 'LOOSE_AGGRESSIVE'), () => 0.01)
  if (action.type === 'bet') {
    assert.ok(Number.isSafeInteger(action.amount))
    assert.ok((action.amount ?? 0) >= 100 && (action.amount ?? 0) <= 800)
  }
})

test('raise amount is a legal final street contribution and respects minimum raise', () => {
  const action = decideBotAction(context({ legalActions: ['fold', 'call', 'raise'], minRaiseTo: 400 }), profile('STRONG', 'LOOSE_AGGRESSIVE'), () => 0.02)
  if (action.type === 'raise') {
    assert.ok((action.amount ?? 0) >= 400)
    assert.ok((action.amount ?? 0) <= 1000)
  }
})

test('closed raise rights never force an all-in short raise', () => {
  const action = decideBotAction(context({ stack: 400, streetContribution: 100, toCall: 100, currentBet: 200, minRaiseTo: 500, raiseReopened: false, legalActions: ['fold', 'call', 'all-in'] }), profile('LOOSE_AGGRESSIVE', 'LOOSE_AGGRESSIVE'), () => 0.01)
  assert.notEqual(action.type, 'all-in')
})

test('seeded random produces reproducible action sequences', () => {
  const a = Array.from({ length: 30 }, (_, index) => decideBotAction(context({ playerId: `a-${index}` }), profile('CASUAL', 'BALANCED'), createSeededBotRandom(123 + index)))
  const b = Array.from({ length: 30 }, (_, index) => decideBotAction(context({ playerId: `a-${index}` }), profile('CASUAL', 'BALANCED'), createSeededBotRandom(123 + index)))
  assert.deepEqual(a, b)
})

test('styles produce materially different aggression distributions', () => {
  const run = (playStyle: BotPlayStyle) => {
    let aggressive = 0
    for (let index = 0; index < 400; index += 1) {
      const action = decideBotAction(context({ playerId: `p-${index}`, holeCards: [c('9', 'spades'), c('8', 'hearts')] }), profile('REGULAR', playStyle), createSeededBotRandom(index * 7919 + 7))
      if (action.type === 'raise' || action.type === 'all-in') aggressive += 1
    }
    return aggressive
  }
  const lag = run('LOOSE_AGGRESSIVE')
  const tag = run('TIGHT_PASSIVE')
  assert.ok(lag > tag)
})

test('every returned action is in the supplied legal set', () => {
  const legal = ['fold', 'call', 'raise'] as const
  for (let index = 0; index < 200; index += 1) {
    const action = decideBotAction(context({ legalActions: legal }), profile('CASUAL', 'BALANCED'), createSeededBotRandom(index))
    assert.ok(legal.includes(action.type as typeof legal[number]))
  }
})

test('all basic action intents can be selected without bypassing the betting engine', () => {
  const strong = profile('STRONG', 'TIGHT_AGGRESSIVE')
  assert.equal(decideBotAction(context({ currentBet: 0, toCall: 0, legalActions: ['check'] }), strong, () => 0.5).type, 'check')
  assert.equal(decideBotAction(context({ currentBet: 0, toCall: 0, legalActions: ['bet'], minBet: 100 }), strong, () => 0.01).type, 'bet')
  assert.equal(decideBotAction(context({ holeCards: [c('9', 'spades'), c('8', 'hearts')], pot: 1000, currentBet: 100, toCall: 100, legalActions: ['call'] }), profile('CASUAL', 'TIGHT_PASSIVE'), () => 0.01).type, 'call')
  assert.equal(decideBotAction(context({ holeCards: [c('2', 'clubs'), c('7', 'diamonds')], pot: 100, currentBet: 1000, toCall: 1000, legalActions: ['fold', 'call'] }), strong, () => 0.99).type, 'fold')
  assert.equal(decideBotAction(context({ legalActions: ['raise'], minRaiseTo: 300 }), strong, () => 0.01).type, 'raise')
  assert.equal(decideBotAction(context({ stack: 50, toCall: 100, currentBet: 100, legalActions: ['all-in'] }), strong, () => 0.5).type, 'all-in')
  assert.equal(decideBotAction(context({ stack: 50, toCall: 100, currentBet: 100, raiseReopened: false, legalActions: ['all-in'] }), strong, () => 0.01).type, 'all-in')
  assert.equal(decideBotAction(context({ stack: 1000, toCall: 100, currentBet: 100, minRaiseTo: 300, legalActions: ['all-in'] }), strong, () => 0.01).type, 'all-in')
})

test('position, public player count, and public aggression influence decisions', () => {
  const early = decideBotAction(context({ holeCards: [c('J', 'spades'), c('T', 'hearts')], position: 'EARLY', activePlayers: 6, actionHistory: [{ type: 'raise', street: 'PREFLOP' }] }), profile('REGULAR', 'BALANCED'), () => 0.65)
  const late = decideBotAction(context({ holeCards: [c('J', 'spades'), c('T', 'hearts')], position: 'LATE', activePlayers: 2 }), profile('REGULAR', 'BALANCED'), () => 0.65)
  assert.ok(['fold', 'call', 'raise', 'all-in'].includes(early.type))
  assert.ok(['fold', 'call', 'raise', 'all-in'].includes(late.type))
  assert.notDeepEqual(early, late)
})

test('all four streets use known board information and remain bounded', () => {
  const boardByStreet = {
    FLOP: [c('A', 'clubs'), c('7', 'diamonds'), c('2', 'hearts')],
    TURN: [c('A', 'clubs'), c('7', 'diamonds'), c('2', 'hearts'), c('9', 'spades')],
    RIVER: [c('A', 'clubs'), c('7', 'diamonds'), c('2', 'hearts'), c('9', 'spades'), c('K', 'clubs')]
  } as const
  for (const street of ['FLOP', 'TURN', 'RIVER'] as const) {
    const action = decideBotAction(context({ street, board: boardByStreet[street] }), profile('REGULAR', 'BALANCED'), createSeededBotRandom(street.length))
    assert.ok(['fold', 'call', 'raise', 'all-in'].includes(action.type))
    assert.ok(action.strength >= 0 && action.strength <= 1)
  }
})

test('fairness: changing hidden opponent cards outside the public context cannot change a seeded decision', () => {
  const publicContext = context({
    street: 'FLOP',
    board: [c('K', 'clubs'), c('7', 'diamonds'), c('2', 'hearts')],
    publicPlayers: [
      { playerId: 'bot-1', stack: 900, streetContribution: 100, status: 'ACTIVE' },
      { playerId: 'opponent', stack: 900, streetContribution: 100, status: 'ACTIVE' }
    ],
    activePlayers: 2
  })
  const withHiddenA = { ...publicContext, opponentHoleCards: [c('A', 'spades'), c('A', 'hearts')] } as unknown as BotDecisionContext
  const withHiddenB = { ...publicContext, opponentHoleCards: [c('2', 'clubs'), c('3', 'clubs')] } as unknown as BotDecisionContext
  assert.deepEqual(decideBotAction(withHiddenA, profile('STRONG', 'BALANCED'), createSeededBotRandom(42)), decideBotAction(withHiddenB, profile('STRONG', 'BALANCED'), createSeededBotRandom(42)))
})

test('invalid evaluator input falls back to a legal conservative action', () => {
  const action = decideBotAction(context({ holeCards: [c('A', 'spades'), c('A', 'spades')], legalActions: ['fold', 'call'] }), profile('STRONG', 'BALANCED'), () => 0.99)
  assert.ok(['fold', 'call'].includes(action.type))
  assert.equal(action.rationale, 'fallback')
})

test('closed raise rights prevent all-in from being used as an illegal raise', () => {
  const action = decideBotAction(context({ raiseReopened: false, stack: 500, streetContribution: 100, currentBet: 200, toCall: 100, legalActions: ['fold', 'call', 'all-in'] }), profile('STRONG', 'LOOSE_AGGRESSIVE'), () => 0.01)
  assert.notEqual(action.type, 'all-in')
})

test('closed raise rights also block an all-in raise when no call is owed', () => {
  const action = decideBotAction(context({ raiseReopened: false, stack: 500, streetContribution: 200, currentBet: 200, toCall: 0, legalActions: ['check', 'all-in'] }), profile('STRONG', 'LOOSE_AGGRESSIVE'), () => 0.01)
  assert.equal(action.type, 'check')
})

test('TAG and LAG aliases map to distinct aggressive style behavior', () => {
  const tag = decideBotAction(context({ holeCards: [c('9', 'spades'), c('8', 'hearts')] }), { skillTier: 'REGULAR', playStyle: 'TAG' }, () => 0.2)
  const lag = decideBotAction(context({ holeCards: [c('9', 'spades'), c('8', 'hearts')] }), { skillTier: 'REGULAR', playStyle: 'LAG' }, () => 0.2)
  assert.notDeepEqual(tag, lag)
})

test('all strategy profiles produce bounded, legal decisions in 2/3/6-player contexts', () => {
  const profiles = [
    ['WEAK', 'LOOSE_PASSIVE'], ['WEAK', 'TIGHT_PASSIVE'], ['WEAK', 'LOOSE_AGGRESSIVE'],
    ['CASUAL', 'BALANCED'], ['CASUAL', 'TIGHT_AGGRESSIVE'], ['CASUAL', 'LOOSE_PASSIVE'],
    ['REGULAR', 'LOOSE_AGGRESSIVE'], ['REGULAR', 'TIGHT_AGGRESSIVE'], ['REGULAR', 'BALANCED'],
    ['STRONG', 'TIGHT_PASSIVE'], ['STRONG', 'TIGHT_AGGRESSIVE'], ['STRONG', 'BALANCED']
  ] as const
  for (const [skillTier, playStyle] of profiles) {
    for (const activePlayers of [2, 3, 6]) {
      const action = decideBotAction(context({ activePlayers, publicPlayers: Array.from({ length: activePlayers }, (_, index) => ({ playerId: index === 0 ? 'bot-1' : `opponent-${index}`, stack: 1000, streetContribution: 100, status: 'ACTIVE' as const })) }), { skillTier, playStyle }, createSeededBotRandom(activePlayers * 17))
      assert.ok(['fold', 'check', 'call', 'bet', 'raise', 'all-in'].includes(action.type))
      if (action.amount !== undefined) assert.ok(Number.isSafeInteger(action.amount) && action.amount > 0 && action.amount <= 1000)
    }
  }
})

test('decision output survives authoritative betting validation for 2, 3 and 6 players', () => {
  for (const playerCount of [2, 3, 6]) {
    let hand = startHand({
      players: Array.from({ length: playerCount }, (_, index) => ({ playerId: `player-${index}`, seat: index + 1, stack: 2000 })),
      smallBlind: 50,
      bigBlind: 100,
      deck: createShuffledDeck()
    })
    for (let step = 0; step < 30 && hand.currentActor !== null && !hand.bettingRoundComplete; step += 1) {
      const player = hand.players.find(candidate => candidate.seat === hand.currentActor)!
      const toCall = getToCall(hand, player.playerId)
      const previousLevel = hand.lastActedAtBet.find(level => level.playerId === player.playerId)
      const raiseReopened = !previousLevel || hand.currentBet - previousLevel.bet >= hand.lastFullRaiseSize
      const legal: Array<'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in'> = ['fold']
      if (toCall === 0) legal.push('check')
      else if (toCall <= player.stack) legal.push('call')
      if (hand.currentBet === 0) legal.push('bet')
      else if (raiseReopened) legal.push('raise')
      legal.push('all-in')
      const action = decideBotAction({
        playerId: player.playerId,
        seat: player.seat,
        dealerSeat: hand.dealerSeat,
        smallBlindSeat: hand.smallBlindSeat,
        bigBlindSeat: hand.bigBlindSeat,
        street: hand.street as 'PREFLOP',
        holeCards: player.holeCards,
        board: hand.board,
        pot: hand.pot,
        currentBet: hand.currentBet,
        streetContribution: player.streetContribution,
        toCall,
        stack: player.stack,
        smallBlind: hand.smallBlind,
        bigBlind: hand.bigBlind,
        activePlayers: hand.players.filter(candidate => candidate.status !== 'FOLDED' && candidate.status !== 'OUT').length,
        publicPlayers: hand.players.map(candidate => ({ playerId: candidate.playerId, seat: candidate.seat, stack: candidate.stack, streetContribution: candidate.streetContribution, status: candidate.status })),
        minRaiseTo: getMinimumRaiseTo(hand),
        raiseReopened,
        legalActions: legal,
        position: player.seat === hand.dealerSeat ? 'DEALER' : player.seat === hand.bigBlindSeat ? 'BIG_BLIND' : 'MIDDLE'
      }, { skillTier: 'REGULAR', playStyle: 'BALANCED' }, createSeededBotRandom(playerCount * 100 + step))
      assert.doesNotThrow(() => { hand = applyBettingAction(hand, { playerId: action.playerId, type: action.type, amount: action.amount }) })
    }
  }
})

test('decision work stays bounded for a large offline simulation', () => {
  const started = Date.now()
  let decisions = 0
  const profiles = [
    ['WEAK', 'LOOSE_PASSIVE'], ['WEAK', 'TIGHT_PASSIVE'], ['WEAK', 'LOOSE_AGGRESSIVE'],
    ['CASUAL', 'BALANCED'], ['CASUAL', 'TIGHT_AGGRESSIVE'], ['CASUAL', 'LOOSE_PASSIVE'],
    ['REGULAR', 'LOOSE_AGGRESSIVE'], ['REGULAR', 'TIGHT_AGGRESSIVE'], ['REGULAR', 'BALANCED'],
    ['STRONG', 'TIGHT_PASSIVE'], ['STRONG', 'TIGHT_AGGRESSIVE'], ['STRONG', 'BALANCED']
  ] as const
  const counts = new Map<string, number>()
  for (let index = 0; index < 5000; index += 1) {
    const [skillTier, playStyle] = profiles[index % profiles.length]!
    const action = decideBotAction(context({
      playerId: `sim-${index}`,
      street: index % 3 === 0 ? 'PREFLOP' : index % 3 === 1 ? 'FLOP' : 'TURN',
      board: index % 3 === 0 ? [] : [c('K', 'clubs'), c('7', 'diamonds'), c('2', 'hearts'), ...(index % 3 === 2 ? [c('9', 'spades')] : [])],
      activePlayers: 2 + (index % 5)
    }), { skillTier, playStyle }, createSeededBotRandom(index + 500))
    assert.ok(['fold', 'check', 'call', 'bet', 'raise', 'all-in'].includes(action.type))
    counts.set(action.type, (counts.get(action.type) ?? 0) + 1)
    decisions += 1
  }
  assert.equal(decisions, 5000)
  assert.ok((counts.get('fold') ?? 0) > 0)
  assert.ok((counts.get('call') ?? 0) > 0)
  assert.ok((counts.get('raise') ?? 0) > 0)
  assert.ok((counts.get('all-in') ?? 0) === 0)
  assert.ok(Date.now() - started < 2000)
})
