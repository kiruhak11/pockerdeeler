import test from 'node:test'
import assert from 'node:assert/strict'
import { createPredefinedDeck, createStandardDeck, type Card, type Rank, type Suit } from '../server/utils/pokerDeck'
import { finishHand } from '../server/utils/pokerHandFinalizer'
import { startHand, type HandStartPlayer, type InternalHandState } from '../server/utils/pokerHandState'
import { buildFinalizedHandResult } from '../server/utils/pokerShowdownPresentation'
import { finalizeTableHand, createPokerTable, seatPlayer, setPlayerReady, startTableHand, toPlayerSafeTableState } from '../server/utils/pokerTableState'
import { createOnlineRoom } from '../server/utils/pokerOnlineRoom'
import { deserializeOnlineRoomRuntimeState, serializeOnlineRoomRuntimeState } from '../server/services/onlineRoomRuntimeStore'

const ranks: Record<string, Rank> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A'
}
const suits: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

function cards(notation: string): Card[] {
  return notation.split(/\s+/).filter(Boolean).map(token => ({ rank: ranks[token.slice(0, -1)]!, suit: suits[token.slice(-1)]! }))
}

type Spec = Readonly<{ playerId: string; seat: number; hole: string; contribution: number; status?: InternalHandState['players'][number]['status'] }>

function manualState(board: string, specs: readonly Spec[], street: InternalHandState['street'] = 'SHOWDOWN'): InternalHandState {
  const basePlayers: HandStartPlayer[] = specs.map(spec => ({ playerId: spec.playerId, seat: spec.seat, stack: 1_000 }))
  const base = startHand({ players: basePlayers, smallBlind: 5, bigBlind: 10, deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const players = Object.freeze(specs.map((spec, index) => Object.freeze({
    ...base.players[index]!,
    playerId: spec.playerId,
    seat: spec.seat,
    stack: 1_000 - spec.contribution,
    holeCards: cards(spec.hole) as readonly [Card, Card],
    contribution: spec.contribution,
    streetContribution: 0,
    status: spec.status ?? 'ACTIVE'
  })))
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

function makePresentation(board: string, specs: readonly Spec[]) {
  const hand = manualState(board, specs)
  const result = finishHand(hand)
  return { hand, result, presentation: buildFinalizedHandResult(hand, result) }
}

test('single winner presentation contains nickname-ready player, label, payout and structural cards', () => {
  const { presentation } = makePresentation('2c 7d 9h Js Qc', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'loser', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  const winner = presentation.players.find(player => player.playerId === 'winner')!
  assert.equal(winner.winner, true)
  assert.equal(winner.label, 'Стрит')
  assert.equal(winner.payout, 200)
  assert.deepEqual(winner.holeCards, cards('Kd Td'))
  assert.deepEqual([...winner.contributingCardIds].sort(), ['9:hearts', 'T:diamonds', 'J:spades', 'Q:clubs', 'K:diamonds'].sort())
  assert.equal(presentation.players.find(player => player.playerId === 'loser')!.winner, false)
})

test('all non-folded showdown participants are revealed and folded cards are omitted', () => {
  const { presentation } = makePresentation('2c 7d 9h Js Qc', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'showdown', seat: 2, hole: 'As Ah', contribution: 100 },
    { playerId: 'folded', seat: 3, hole: 'Ac Ad', contribution: 100, status: 'FOLDED' }
  ])
  assert.deepEqual(presentation.players.map(player => player.playerId), ['winner', 'showdown'])
  assert.equal(presentation.players.every(player => player.holeCards.length === 2), true)
})

test('split and side-pot payouts are preserved per winner', () => {
  const { presentation } = makePresentation('As Kd Qc Jh Ts', [
    { playerId: 'short', seat: 1, hole: '2c 3d', contribution: 50, status: 'ALL_IN' },
    { playerId: 'middle', seat: 2, hole: '4c 5d', contribution: 100, status: 'ALL_IN' },
    { playerId: 'deep', seat: 3, hole: '6c 7d', contribution: 150 }
  ])
  assert.equal(presentation.pots.length, 2)
  assert.deepEqual(presentation.pots.map(pot => [...pot.winnerIds].sort()), [['short', 'middle', 'deep'], ['middle', 'deep']].map(items => items.sort()))
  assert.equal(presentation.players.find(player => player.playerId === 'short')!.payout, 50)
  assert.equal(presentation.players.find(player => player.playerId === 'middle')!.payout, 100)
})

test('returned excess is separate from payout and never marks a false winner', () => {
  const { presentation } = makePresentation('2c 7d 9h Js Qc', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100, status: 'ALL_IN' },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100, status: 'ALL_IN' },
    { playerId: 'deep', seat: 3, hole: '8s 6c', contribution: 500 }
  ])
  assert.deepEqual(presentation.returnedExcess, [{ playerId: 'deep', amount: 400 }])
  assert.equal(presentation.players.find(player => player.playerId === 'deep')!.winner, false)
  assert.equal(presentation.players.find(player => player.playerId === 'deep')!.returnedExcess, 400)
})

test('uncontested result has winner and payout but no combination or revealed cards', () => {
  const hand = manualState('2c 7d 9h Js Qc', [
    { playerId: 'winner', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'folded', seat: 2, hole: 'As Ah', contribution: 100, status: 'FOLDED' }
  ])
  const result = finishHand(hand)
  const final = buildFinalizedHandResult(hand, result)
  assert.equal(final.type, 'UNCONTESTED')
  assert.deepEqual(final.players.map(player => player.playerId), ['winner'])
  assert.equal(final.players[0]!.payout, 200)
  assert.equal(final.players[0]!.label, null)
  assert.deepEqual(final.players[0]!.holeCards, [])
})

test('every supported showdown category gets a server label and winning structural cards', () => {
  const fixtures: readonly [string, string, string][] = [
    ['2c 7d 9h Js Qc', 'Kd Td', 'Стрит'],
    ['As 7d 9h Jc 2c', 'Ah Kd', 'Пара'],
    ['As Kd Qc Jh Ts', '2c 3d', 'Стрит'],
    ['2c 2d 7h 9s Jc', '2h 3d', 'Сет'],
    ['As 7s 9s Js 2s', 'Ks Qs', 'Флеш'],
    ['As Ad 7c 7h 2s', 'Ac Kd', 'Фулл-хаус'],
    ['As Ad Ah Ac 2s', 'Kc Qd', 'Каре'],
    ['9s Ts Js Qs 2d', 'Ks 3c', 'Стрит-флеш']
  ]
  for (const [board, hole, label] of fixtures) {
    const final = makePresentation(board, [
      { playerId: 'winner', seat: 1, hole, contribution: 100 },
      { playerId: 'other', seat: 2, hole: '3h 4h', contribution: 100 }
    ]).presentation
    const winner = final.players.find(player => player.playerId === 'winner')!
    assert.equal(winner.label, label, `${board} ${hole}`)
    assert.ok(winner.contributingCardIds.length > 0)
  }
})

test('finalized table safe state exposes result but no internal deck or burn cards', () => {
  let table = createPokerTable({ tableId: 'presentation-table', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const started = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const hand = manualState('2c 7d 9h Js Qc', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  const terminal = Object.freeze({ ...started, currentHand: hand, players: started.players.map(player => ({ ...player, stack: 0 })) })
  const settled = finalizeTableHand(terminal)
  const safe = toPlayerSafeTableState(settled, 'a')
  assert.ok(safe.finalizedHand)
  assert.equal(safe.finalizedHand!.players.every(player => player.holeCards.length === 2), true)
  assert.equal('deck' in (safe.finalizedHand as object), false)
  assert.equal('burnCards' in (safe.finalizedHand as object), false)
  assert.equal('deck' in (safe.currentHand as object), false)
})

test('opponent cards remain hidden before authoritative finalization', () => {
  let table = createPokerTable({ tableId: 'pre-finish', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const running = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const showdown = Object.freeze({ ...running, currentHand: Object.freeze({ ...running.currentHand!, street: 'SHOWDOWN' as const, board: Object.freeze(cards('2c 7d 9h Js Qc')), bettingRoundComplete: true, currentActor: null }) })
  const safe = toPlayerSafeTableState(showdown, 'a')
  assert.equal(safe.finalizedHand, null)
  assert.equal(safe.currentHand!.players.find(player => player.playerId === 'b')!.holeCards.length, 0)
})

test('next hand clears the previous finalized presentation', () => {
  const base = manualState('2c 7d 9h Js Qc', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  const result = finishHand(base)
  let table = createPokerTable({ tableId: 'next-hand', smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: 'a', seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: 'b', seat: 2, stack: 100, ready: true })
  const started = startTableHand(table, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  const settled = finalizeTableHand(Object.freeze({ ...started, currentHand: base }))
  assert.ok(settled.finalizedHand)
  const next = startTableHand(settled, { deck: createPredefinedDeck(createStandardDeck().availableCards) })
  assert.equal(next.finalizedHand, null)
  void result
})

test('finished result survives server runtime serialization for reconnect', () => {
  const { presentation } = makePresentation('2c 7d 9h Js Qc', [
    { playerId: 'a', seat: 1, hole: 'Kd Td', contribution: 100 },
    { playerId: 'b', seat: 2, hole: 'As Ah', contribution: 100 }
  ])
  const room = createOnlineRoom({ roomId: 'runtime-presentation', roomCode: 'AB2345', ownerId: 'a', ownerStack: 100, smallBlind: 5, bigBlind: 10 })
  const state = Object.freeze({ ...room, pokerTable: Object.freeze({ ...room.pokerTable, finalizedHand: presentation }) })
  const restored = deserializeOnlineRoomRuntimeState(serializeOnlineRoomRuntimeState(state), state.roomId).state
  assert.deepEqual(restored.pokerTable.finalizedHand, presentation)
  assert.deepEqual(restored.pokerTable.finalizedHand?.players.map(player => player.holeCards.length), [2, 2])
})
