import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateIntegerByWeight,
  calculateBehaviorScores,
  calculatePredictionQuotes,
  settlePredictionPool
} from '../app/utils/predictionCalculations'
import { calculateFixedPredictionQuotes, fixedPredictionPayout, requiredPredictionReserve, settleFixedPredictions } from '../app/utils/predictionCalculations'

test('fixed prices change by street, but accepted payout stays integer and immutable', () => {
  const inputs = ['a', 'b'].map((playerId, seat) => ({ playerId, playerName: playerId, seat, probability: 0.5, available: true, reasonCodes: [], realStake: 0 }))
  const pre = calculateFixedPredictionQuotes(inputs, 100, 'preflop')[0]!
  const flop = calculateFixedPredictionQuotes(inputs, 100, 'flop')[0]!
  const river = calculateFixedPredictionQuotes(inputs, 100, 'river')[0]!
  assert.equal(pre.odds, 2)
  assert.equal(flop.odds, 1.95)
  assert.equal(river.odds, 1.85)
  assert.equal(fixedPredictionPayout(7n, 195), 13n)
  assert.throws(() => fixedPredictionPayout(0n, 195))
  assert.throws(() => fixedPredictionPayout(5n, 195.5))
})

test('reserve covers the worst winning candidate and preserves promised payouts', () => {
  const tickets = [
    { id: '1', candidatePlayerId: 'a', stake: 50n, potentialPayout: 100n },
    { id: '2', candidatePlayerId: 'a', stake: 40n, potentialPayout: 80n },
    { id: '3', candidatePlayerId: 'b', stake: 85n, potentialPayout: 170n }
  ]
  assert.equal(requiredPredictionReserve(120n, tickets), 60n)
  const settled = settleFixedPredictions(200n, ['a'], tickets)
  assert.equal(settled.payouts.get('1'), 100)
  assert.equal(settled.payouts.get('2'), 80)
  assert.equal(settled.payouts.get('3'), 0)
  assert.equal(settled.treasuryReturn, 20)
  assert.throws(() => settleFixedPredictions(179n, ['a'], tickets))
  assert.equal(settleFixedPredictions(200n, ['unknown'], tickets).treasuryReturn, 200)
})

test('fixed prediction keeps the stake and splits only the net profit', () => {
  const settled = settleFixedPredictions(500n, ['a', 'b'], [
    { id: 'ticket', candidatePlayerId: 'a', stake: 100n, potentialPayout: 300n }
  ])
  assert.equal(settled.payouts.get('ticket'), 200)
})

test('largest-remainder allocation never loses a chip and follows seat order on ties', () => {
  const allocation = allocateIntegerByWeight(10, [
    { id: 'seat-3', weight: 1, order: 3 },
    { id: 'seat-1', weight: 1, order: 1 },
    { id: 'seat-2', weight: 1, order: 2 }
  ])

  assert.equal([...allocation.values()].reduce((sum, value) => sum + value, 0), 10)
  assert.deepEqual(Object.fromEntries(allocation), { 'seat-3': 3, 'seat-1': 4, 'seat-2': 3 })
})

test('public behavior model excludes folded players and normalizes active scores', () => {
  const scores = calculateBehaviorScores([
    { playerId: 'steady', playerName: 'Steady', seat: 1, stack: 6000, currentBet: 100, totalCommitted: 100, status: 'active', actionTypes: ['call'] },
    { playerId: 'push', playerName: 'Push', seat: 2, stack: 1000, currentBet: 5000, totalCommitted: 5000, status: 'all-in', actionTypes: ['all-in'] },
    { playerId: 'folded', playerName: 'Folded', seat: 3, stack: 5000, currentBet: 100, totalCommitted: 100, status: 'folded', actionTypes: ['fold'] }
  ], { behaviorImpact: 0.2, bigBlind: 100, includeDecisionTime: false })

  assert.equal(scores.find(item => item.playerId === 'folded')?.available, false)
  assert.equal(scores.find(item => item.playerId === 'folded')?.probability, 0)
  assert.ok((scores.find(item => item.playerId === 'push')?.reasonCodes || []).includes('all_in_now'))
  const total = scores.reduce((sum, item) => sum + item.probability, 0)
  assert.ok(Math.abs(total - 1) < 1e-12)
})

test('quotes preserve virtual liquidity and react to real stakes', () => {
  const quotes = calculatePredictionQuotes([
    { playerId: 'a', playerName: 'A', seat: 1, probability: 0.5, reasonCodes: [], available: true, realStake: 300 },
    { playerId: 'b', playerName: 'B', seat: 2, probability: 0.3, reasonCodes: [], available: true, realStake: 0 },
    { playerId: 'c', playerName: 'C', seat: 3, probability: 0.2, reasonCodes: [], available: true, realStake: 0 }
  ], 1001)

  assert.equal(quotes.reduce((sum, quote) => sum + quote.virtualStake, 0), 1001)
  assert.ok(quotes.every(quote => quote.odds >= 1))
  assert.ok(quotes[0]!.odds < quotes[1]!.odds, 'real money on A must shorten its indicative odds')
})

test('prediction settlement conserves the full integer pool including odd chips', () => {
  const settlement = settlePredictionPool({
    totalPool: 1703,
    winnerVirtualStake: 503,
    winningBets: [
      { id: 'first', stake: 100, createdAt: 1 },
      { id: 'second', stake: 100, createdAt: 2 }
    ]
  })
  const paid = [...settlement.payouts.values()].reduce((sum, value) => sum + value, 0)

  assert.equal(paid + settlement.treasuryReturn, 1703)
  assert.ok((settlement.payouts.get('first') || 0) >= (settlement.payouts.get('second') || 0))
})

test('without a correct spectator prediction the whole market returns to treasury', () => {
  const settlement = settlePredictionPool({ totalPool: 1250, winnerVirtualStake: 400, winningBets: [] })
  assert.equal(settlement.treasuryReturn, 1250)
  assert.equal(settlement.payouts.size, 0)
})
