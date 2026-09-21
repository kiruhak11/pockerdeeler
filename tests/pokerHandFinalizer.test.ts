import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBettingAction, getToCall } from '../server/utils/pokerBetting'
import { createPredefinedDeck, createStandardDeck, type Card, type Rank, type Suit } from '../server/utils/pokerDeck'
import { finishHand, type HandFinalizationResult } from '../server/utils/pokerHandFinalizer'
import { advanceStreet, startHand, type HandStartPlayer, type InternalHandState } from '../server/utils/pokerHandState'

const ranks: Record<string, Rank> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7',
  '8': '8', '9': '9', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A'
}
const suits: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

function cards(notation: string): Card[] {
  return notation.split(/\s+/).filter(Boolean).map(token => ({
    rank: ranks[token.slice(0, -1)]!,
    suit: suits[token.slice(-1)]!
  }))
}

type ManualPlayer = Readonly<{
  playerId: string
  seat: number
  hole: string
  contribution: number
  stack?: number
  status?: InternalHandState['players'][number]['status']
}>

function standardDeck() {
  return createPredefinedDeck(createStandardDeck().availableCards)
}

function manualState(
  board: string,
  specs: readonly ManualPlayer[],
  street: InternalHandState['street'] = 'SHOWDOWN'
): InternalHandState {
  const basePlayers: HandStartPlayer[] = specs.map(spec => ({
    playerId: spec.playerId,
    seat: spec.seat,
    stack: (spec.stack ?? 1_000 - spec.contribution) + spec.contribution
  }))
  const base = startHand({ players: basePlayers, smallBlind: 5, bigBlind: 10, deck: standardDeck() })
  const players = Object.freeze(specs.map((spec, index) => {
    const holeCards = cards(spec.hole)
    return Object.freeze({
      ...base.players[index]!,
      playerId: spec.playerId,
      seat: spec.seat,
      stack: spec.stack ?? 1_000 - spec.contribution,
      holeCards: [holeCards[0]!, holeCards[1]!] as readonly [Card, Card],
      contribution: spec.contribution,
      streetContribution: 0,
      status: spec.status ?? 'ACTIVE'
    })
  }))
  return Object.freeze({
    ...base,
    players,
    board: Object.freeze(cards(board)),
    street,
    pot: specs.reduce((sum, spec) => sum + spec.contribution, 0),
    currentBet: 0,
    actedThisRound: Object.freeze([]),
    lastActedAtBet: Object.freeze([]),
    bettingRoundComplete: true,
    currentActor: null
  })
}

function start(count = 2, stack = 100): InternalHandState {
  const players = Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    seat: index + 1,
    stack
  }))
  return startHand({ players, smallBlind: 5, bigBlind: 10, deck: standardDeck() })
}

function completeCurrentRound(state: InternalHandState): InternalHandState {
  let next = state
  while (!next.bettingRoundComplete) {
    const actor = next.players.find(player => player.seat === next.currentActor)
    assert.ok(actor)
    next = applyBettingAction(next, {
      playerId: actor.playerId,
      type: getToCall(next, actor.playerId) > 0 ? 'call' : 'check'
    })
  }
  return next
}

function toShowdown(count = 2): InternalHandState {
  let state = start(count)
  while (state.street !== 'SHOWDOWN') {
    state = advanceStreet(completeCurrentRound(state))
  }
  return state
}

function totalFinalStacks(result: HandFinalizationResult): number {
  return result.players.reduce((sum, player) => sum + player.stack, 0)
}

const highCardBoard = '2c 7d 9h Js Qc'
const broadway = 'As Kd Qc Jh Ts'

test('normal river showdown follows build, showdown, and payout flow', () => {
  const state = toShowdown(2)
  const result = finishHand(state)
  assert.equal(result.type, 'CONTESTED')
  assert.equal(result.reason, 'SHOWDOWN')
  assert.equal(result.board.length, 5)
  assert.equal(result.showdown?.pots.length, result.pots.length)
})

test('main pot single winner produces final stacks and winner data', () => {
  const state = manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  const result = finishHand(state)
  assert.deepEqual(result.pots[0]!.winnerIds, ['a'])
  assert.deepEqual(result.payouts, [{ playerId: 'a', amount: 200 }, { playerId: 'b', amount: 0 }])
  assert.equal(result.players.find(player => player.playerId === 'a')!.stack, 1_100)
})

test('main and side pots are finalized independently', () => {
  const result = finishHand(manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 300, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: '8s 6c', contribution: 500 }
  ]))
  assert.deepEqual(result.pots.map(pot => pot.winnerIds), [['a'], ['b']])
  assert.deepEqual(result.pots.map(pot => pot.amount), [300, 400])
})

test('multiple side pots and returned excess remain visible in final result', () => {
  const result = finishHand(manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 50, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: 'Ks Kh', contribution: 150, status: 'ALL_IN' },
    { playerId: 'd', seat: 4, hole: '8s 6c', contribution: 200 }
  ]))
  assert.deepEqual(result.pots.map(pot => pot.winnerIds), [['a'], ['b'], ['c']])
  assert.deepEqual(result.returnedExcess, [{ playerId: 'd', amount: 50 }])
})

test('split pot and odd chip data are finalized', () => {
  const state = manualState('As 7d 9h Jc 2c', [
    { playerId: 'a', seat: 1, hole: 'Ah Kd', contribution: 50 },
    { playerId: 'b', seat: 3, hole: 'Ad Kh', contribution: 50 },
    { playerId: 'c', seat: 5, hole: 'Ac Ks', contribution: 50 },
    { playerId: 'loser', seat: 7, hole: 'Qh Qd', contribution: 50 }
  ])
  const result = finishHand(Object.freeze({ ...state, dealerSeat: 3 }))
  assert.equal(result.pots[0]!.split, true)
  assert.deepEqual(result.pots[0]!.oddChipRecipients, ['c', 'a'])
  assert.equal(result.pots[0]!.payouts.reduce((sum, item) => sum + item.amount, 0), 200)
})

test('all-in automatic runout reaches normal contested finalization', () => {
  const state = advanceStreet(start(2, 5))
  assert.equal(state.street, 'SHOWDOWN')
  const result = finishHand(state)
  assert.equal(result.type, 'CONTESTED')
  assert.equal(result.reason, 'SHOWDOWN')
  assert.equal(result.showdown?.pots.length, 1)
})

test('uncontested preflop fold win skips showdown and awards the pot', () => {
  const state = manualState('', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 10 },
    { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' }
  ], 'PREFLOP')
  const result = finishHand(state)
  assert.equal(result.type, 'UNCONTESTED')
  assert.equal(result.reason, 'UNCONTESTED_FOLD')
  assert.equal(result.showdown, null)
  assert.equal(result.board.length, 0)
  assert.equal(result.players.find(player => player.playerId === 'winner')!.stack, 1_005)
  assert.equal(result.players.find(player => player.playerId === 'folded')!.stack, 995)
})

test('uncontested flop fold win does not require a five-card board', () => {
  const result = finishHand(manualState('2c 7d 9h', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 10 },
    { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' }
  ], 'FLOP'))
  assert.equal(result.reason, 'UNCONTESTED_FOLD')
  assert.equal(result.board.length, 3)
  assert.equal(result.showdown, null)
})

test('uncontested turn and river fold wins keep their current boards', () => {
  for (const [street, board] of [
    ['TURN', '2c 7d 9h Js'],
    ['RIVER', highCardBoard]
  ] as const) {
    const result = finishHand(manualState(board, [
      { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 10 },
      { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' }
    ], street))
    assert.equal(result.reason, 'UNCONTESTED_FOLD')
    assert.equal(result.board.length, street === 'TURN' ? 4 : 5)
    assert.equal(result.showdown, null)
  }
})

test('uncontested finalization does not invoke showdown or expose folded hole cards', () => {
  const result = finishHand(manualState('', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 10 },
    { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' }
  ], 'PREFLOP'))
  assert.equal(result.showdown, null)
  assert.equal('deck' in result, false)
  assert.equal('burnCards' in result, false)
  assert.equal(result.players.some(player => 'holeCards' in player), false)
  assert.equal(JSON.stringify(result).includes('As'), false)
})

test('contested hand cannot finish before SHOWDOWN', () => {
  const state = manualState('', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 10 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 10 }
  ], 'PREFLOP')
  assert.throws(() => finishHand(state), /SHOWDOWN/)
})

test('hand with no non-folded player is rejected', () => {
  const state = manualState('', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 10, status: 'FOLDED' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 10, status: 'OUT' }
  ], 'FINISHED')
  assert.throws(() => finishHand(state), /without a non-folded player/)
})

test('source hand state is not mutated', () => {
  const state = toShowdown(2)
  const before = structuredClone({
    players: state.players,
    board: state.board,
    pot: state.pot,
    street: state.street,
    currentActor: state.currentActor
  })
  finishHand(state)
  assert.deepEqual({
    players: state.players,
    board: state.board,
    pot: state.pot,
    street: state.street,
    currentActor: state.currentActor
  }, before)
})

test('final stacks and chip conservation include contributions and excess', () => {
  const state = manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 300 },
    { playerId: 'c', seat: 3, hole: '8s 6c', contribution: 500 }
  ])
  const before = state.players.reduce((sum, player) => sum + player.stack + player.contribution, 0)
  const result = finishHand(state)
  assert.equal(totalFinalStacks(result), before)
  assert.equal(result.totalPayout + result.totalReturnedExcess, state.pot)
})

test('repeating finish on the same hand is deterministic and cannot double payout', () => {
  const state = toShowdown(2)
  const first = finishHand(state)
  const second = finishHand(state)
  assert.deepEqual(second, first)
  assert.equal(totalFinalStacks(first), totalFinalStacks(second))
})

test('heads-up showdown finalizes both players', () => {
  const result = finishHand(toShowdown(2))
  assert.equal(result.players.length, 2)
  assert.ok(result.pots[0]!.winnerIds.length >= 1)
})

test('six-player side-pot finalization preserves all pots and stacks', () => {
  const state = manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 50, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100, status: 'ALL_IN' },
    { playerId: 'c', seat: 3, hole: 'Ks Kh', contribution: 200, status: 'ALL_IN' },
    { playerId: 'd', seat: 4, hole: 'Qs Qh', contribution: 300 },
    { playerId: 'e', seat: 5, hole: 'Jd Jh', contribution: 300 },
    { playerId: 'f', seat: 6, hole: '8s 6c', contribution: 300, status: 'FOLDED' }
  ])
  const result = finishHand(state)
  assert.deepEqual(result.pots.map(pot => pot.amount), [300, 250, 400, 300])
  assert.equal(totalFinalStacks(result), state.players.reduce((sum, player) => sum + player.stack + player.contribution, 0))
  assert.equal(result.payouts.find(item => item.playerId === 'f')!.amount, 0)
})

test('inconsistent hand pot and contributions are rejected', () => {
  const state = manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  assert.throws(() => finishHand(Object.freeze({ ...state, pot: state.pot + 1 })), /does not match player contributions/)
})

test('completed betting round with a current actor is rejected', () => {
  const state = manualState(highCardBoard, [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  assert.throws(() => finishHand(Object.freeze({ ...state, currentActor: 1 })), /current actor/)
})

test('finished uncontested state remains finalizable without a board runout', () => {
  const state = manualState('', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 10 },
    { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' }
  ], 'FINISHED')
  const result = finishHand(state)
  assert.equal(result.reason, 'UNCONTESTED_FOLD')
  assert.equal(result.board.length, 0)
})

test('uncontested folded contributions stay with the winner rather than returning to a folder', () => {
  const result = finishHand(manualState('', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 0 },
    { playerId: 'folded-a', seat: 2, hole: 'As Ah', contribution: 5, status: 'FOLDED' },
    { playerId: 'folded-b', seat: 3, hole: 'Ks Kh', contribution: 10, status: 'FOLDED' }
  ], 'PREFLOP'))
  assert.equal(result.showdown, null)
  assert.equal(result.players.find(player => player.playerId === 'winner')!.stack, 1_015)
  assert.equal(result.players.find(player => player.playerId === 'folded-b')!.stack, 990)
  assert.ok(result.uncontestedFoldedContributions.length > 0)
})
