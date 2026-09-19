import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterAction, startBetting, nextActor, revealNextStreet, validateRoundAction, removeFromBetting } from '../app/utils/bettingRounds'
import { applyPlayerAction, distributePot, assertChipConservation, getAvailableActions } from '../app/utils/pokerCalculations'
import type { Player } from '../app/types/game'

const players = (): Player[] => [1, 2, 3].map(seat => ({ id: String(seat), name: String(seat), seat, stack: 100, currentBet: 0, totalCommitted: 0, status: 'active' }))

test('three checks close the round; two checks do not', () => {
  let p = players(), round = startBetting(p, 10)
  for (const id of ['1', '2', '3']) {
    p = applyPlayerAction(p, 0, 0, { playerId: id, type: 'check' }).players
    round = afterAction(round, p, id, 0, 0)
    assert.equal(round.phase, id === '3' ? 'reveal' : 'betting')
  }
})

test('raise requires earlier callers to act again', () => {
  let p = players(), round = startBetting(p, 10)
  let r = applyPlayerAction(p, 0, 0, { playerId: '1', type: 'bet', amount: 10 })
  round = afterAction(round, r.players, '1', 0, 10)
  r = applyPlayerAction(r.players, r.pot, r.currentBet, { playerId: '2', type: 'call' })
  round = afterAction(round, r.players, '2', 10, 10)
  r = applyPlayerAction(r.players, r.pot, r.currentBet, { playerId: '3', type: 'raise', amount: 30 })
  round = afterAction(round, r.players, '3', 10, 30)
  assert.deepEqual(round.pending, ['1', '2'])
  assert.equal(round.lastFullRaise, 20)
  assert.equal(nextActor(r.players, round.pending, '3'), '1')
})

test('all-in runout still requires separate flop, turn and river confirmation', () => {
  const p = players().map(p => ({ ...p, stack: 0, status: 'all-in' as const }))
  let round = startBetting(p, 10)
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(round.phase, 'reveal')
    round = revealNextStreet(round, p, 10)
    assert.equal(round.street, street)
  }
  assert.equal(round.phase, 'showdown')
  assert.throws(() => revealNextStreet(round, p, 10))
})

test('last opponent folds: showdown without exposing cards', () => {
  const p = players().slice(0, 2)
  const round = startBetting(p, 10)
  p[1]!.status = 'folded'
  assert.equal(afterAction(round, p, '2', 0, 0).phase, 'showdown')
})

test('departing current player does not stall the round', () => {
  const p = players(), round = startBetting(p, 10)
  p[0]!.status = 'folded'
  const updated = removeFromBetting(round, p, '1', 0)
  assert.equal(nextActor(p, updated.pending, '1'), '2')
})

test('short raise must be called, but cannot reopen a previously completed action', () => {
  const p = players()
  const round = { ...startBetting(p, 10), actedAtBet: { '1': 10 }, lastFullRaise: 10 }
  assert.throws(() => validateRoundAction(round, p[0]!, 'raise', 30, 15), /Короткий/)
  assert.doesNotThrow(() => validateRoundAction(round, p[0]!, 'call', 0, 15))
  assert.doesNotThrow(() => validateRoundAction(round, p[0]!, 'raise', 30, 20))
})

test('waiting and all-in players cannot act', () => {
  for (const status of ['waiting', 'all-in'] as const) {
    const p = { ...players()[0]!, status }
    assert.throws(() => applyPlayerAction([p], 0, 0, { playerId: p.id, type: 'fold' }))
    assert.equal(getAvailableActions(p, { currentBet: 0, handActive: true, isCurrentPlayer: true }).canCheck, false)
  }
})

test('a short all-in call preserves chips and contribution totals', () => {
  const p = players(); p[0]!.stack = 5
  const result = applyPlayerAction(p, 0, 20, { playerId: '1', type: 'call' })
  assert.equal(result.players[0]!.stack, 0)
  assert.equal(result.pot, 5)
  assert.equal(result.players[0]!.status, 'all-in')
  assertChipConservation(result.players, 205)
})

test('split pot remainder goes by seat order and chips are conserved', () => {
  const p = players().map(p => ({ ...p, stack: 99, currentBet: 1, totalCommitted: 1 }))
  p[2]!.status = 'folded'
  const result = distributePot(p, ['2', '1'])
  assert.equal(result.players[0]!.stack, 101)
  assert.equal(result.players[1]!.stack, 100)
  assertChipConservation(result.players, 300)
})

test('short all-in wins only the main pot; side pot has its own winner', () => {
  const p = players().map((p, i) => ({ ...p, stack: 0, currentBet: i === 0 ? 40 : 100, totalCommitted: i === 0 ? 40 : 100, status: 'all-in' as const }))
  assert.throws(() => distributePot(p, ['1']), /банка №2/)
  const result = distributePot(p, ['1', '2'], { '1': ['1'], '2': ['2'] })
  assert.deepEqual(result.players.map(p => p.stack), [120, 120, 0])
  assertChipConservation(result.players, 240)
})

test('uncalled excess is returned separately from winnings', () => {
  const p = players().slice(0, 2).map((p, i) => ({ ...p, stack: 0, currentBet: i === 0 ? 100 : 40, totalCommitted: i === 0 ? 100 : 40, status: 'all-in' as const }))
  const result = distributePot(p, ['2'])
  assert.deepEqual(result.players.map(p => p.stack), [60, 80])
  assert.deepEqual(result.result.returned, [{ playerId: '1', amountWon: 60 }])
})
