import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getToCall } from '../server/utils/pokerBetting'
import { createPredefinedDeck, createStandardDeck } from '../server/utils/pokerDeck'
import {
  applyTableAction,
  createPokerTable,
  finalizeTableHand,
  seatPlayer,
  setPlayerReady,
  startTableHand,
  advanceTableStreet,
  toPlayerSafeTableState,
  type PokerTableState
} from '../server/utils/pokerTableState'
import type { InternalHandState } from '../server/utils/pokerHandState'

function tableWithPlayers(count: number, stack = 1_000): PokerTableState {
  let table = createPokerTable({ tableId: randomUUID(), smallBlind: 5, bigBlind: 10 })
  for (let index = 1; index <= count; index += 1) {
    table = seatPlayer(table, { playerId: `player-${index}`, seat: index, stack })
    table = setPlayerReady(table, `player-${index}`, true)
  }
  return startTableHand(table, { deck: createStandardDeck() })
}

function finishByCalling(table: PokerTableState): PokerTableState {
  let current = table
  for (let guard = 0; guard < 100 && current.currentHand && current.currentHand.street !== 'FINISHED'; guard += 1) {
    const hand = current.currentHand
    if (hand.street === 'SHOWDOWN') break
    if (hand.currentActor === null) {
      current = advanceTableStreet(current)
      continue
    }
    const actor = hand.players.find(player => player.seat === hand.currentActor)!
    current = applyTableAction(current, {
      playerId: actor.playerId,
      type: getToCall(hand, actor.playerId) > 0 ? 'call' : 'check'
    })
  }
  assert.ok(current.currentHand)
  return current
}

function finishAndSettle(table: PokerTableState): PokerTableState {
  const terminal = finishByCalling(table)
  return finalizeTableHand(terminal)
}

function totalStacks(table: PokerTableState): number {
  return table.players.reduce((sum, player) => sum + player.stack, 0)
}

test('heads-up contested hand settles and next hand uses updated stacks', () => {
  const started = tableWithPlayers(2)
  const before = totalStacks(started) + started.currentHand!.pot
  const settled = finishAndSettle(started)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(settled.finalizedHandId, settled.currentHand?.handId)
  assert.equal(settled.status, 'WAITING')
  assert.equal(totalStacks(settled), before)

  const next = startTableHand(settled, { deck: createStandardDeck() })
  assert.equal(next.handSequence, 2)
  assert.equal(next.currentHand?.street, 'PREFLOP')
  assert.equal(next.finalizedHandId, null)
})

test('three-player contested hand settles with conserved chips', () => {
  const started = tableWithPlayers(3)
  const before = totalStacks(started) + started.currentHand!.pot
  const settled = finishAndSettle(started)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(totalStacks(settled), before)
})

test('six-player contested hand settles with conserved chips', () => {
  const started = tableWithPlayers(6)
  const before = totalStacks(started) + started.currentHand!.pot
  const settled = finishAndSettle(started)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(totalStacks(settled), before)
})

test('uncontested heads-up hand pays the pot and becomes startable', () => {
  const started = tableWithPlayers(2)
  const actor = started.currentHand!.players.find(player => player.seat === started.currentHand!.currentActor)!
  const folded = applyTableAction(started, { playerId: actor.playerId, type: 'fold' })
  const terminal = advanceTableStreet(folded)
  assert.equal(terminal.currentHand?.street, 'FINISHED')
  const settled = finalizeTableHand(terminal)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(totalStacks(settled), totalStacks(started) + started.currentHand!.pot)
  assert.equal(startTableHand(settled, { deck: createStandardDeck() }).handSequence, 2)
})

test('uncontested three-player and six-player hands settle after folds', () => {
  for (const count of [3, 6]) {
    let folded = tableWithPlayers(count)
    while (folded.currentHand!.players.filter(player => player.status !== 'FOLDED' && player.status !== 'OUT').length > 1) {
      const actor = folded.currentHand!.players.find(player => player.seat === folded.currentHand!.currentActor)
      assert.ok(actor)
      folded = applyTableAction(folded, { playerId: actor.playerId, type: 'fold' })
    }
    const terminal = folded.currentHand!.street === 'FINISHED' ? folded : advanceTableStreet(folded)
    const settled = finalizeTableHand(terminal)
    assert.equal(settled.currentHand?.street, 'FINISHED')
    assert.ok(settled.players.every(player => player.stack >= 0))
    assert.equal(settled.handSequence, 1)
  }
})

test('automatic all-in runout settles without an extra action', () => {
  const started = tableWithPlayers(2, 5)
  assert.equal(started.currentHand?.currentActor, null)
  const showdown = advanceTableStreet(started)
  assert.equal(showdown.currentHand?.street, 'SHOWDOWN')
  const settled = finalizeTableHand(showdown)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(settled.currentHand?.board.length, 5)
  assert.equal(totalStacks(settled), totalStacks(started) + started.currentHand!.pot)
})

test('repeated finalization is a no-op after the hand marker is written', () => {
  const settled = finishAndSettle(tableWithPlayers(2))
  const repeated = finalizeTableHand(settled)
  assert.equal(repeated, settled)
  assert.deepEqual(repeated.players, settled.players)
  assert.equal(repeated.stateVersion, settled.stateVersion)
})

test('finalization keeps side-pot and returned-excess calculations in the existing engine', () => {
  const started = tableWithPlayers(3)
  const hand = started.currentHand!
  const players = hand.players.map((player, index) => Object.freeze({
    ...player,
    contribution: (index + 1) * 50,
    streetContribution: 0,
    stack: 1_000 - (index + 1) * 50,
    status: index === 0 ? 'ALL_IN' as const : 'ACTIVE' as const
  }))
  const boardDeck = createPredefinedDeck(hand.deck.availableCards)
  const board = boardDeck.dealMany(5)
  const manualHand: InternalHandState = Object.freeze({
    ...hand,
    players: Object.freeze(players),
    board: Object.freeze(board),
    deck: createPredefinedDeck(hand.deck.availableCards.slice(5)),
    street: 'SHOWDOWN',
    pot: 300,
    currentBet: 0,
    actedThisRound: Object.freeze([]),
    lastActedAtBet: Object.freeze([]),
    bettingRoundComplete: true,
    currentActor: null
  })
  const manualTable = Object.freeze({
    ...started,
    players: Object.freeze(started.players.map((player, index) => Object.freeze({ ...player, stack: players[index]!.stack }))),
    currentHand: manualHand
  })
  const settled = finalizeTableHand(manualTable)
  assert.equal(settled.currentHand?.street, 'FINISHED')
  assert.equal(totalStacks(settled), totalStacks(manualTable) + 300)
})

test('source table is immutable and safe state contains no internal hand data', () => {
  const started = tableWithPlayers(2)
  const settled = finishAndSettle(started)
  assert.equal(started.currentHand?.street, 'PREFLOP')
  const safe = toPlayerSafeTableState(settled, 'player-1')
  assert.equal('deck' in (safe.currentHand as object), false)
  assert.equal('burnCards' in (safe.currentHand as object), false)
})
