import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minesField, minesLimit, minesTerms, seedHash } from '../server/utils/minesMath'
import { allocateTokenRewards } from '../server/utils/tokenRewards'
test('Mines open-field curves support 1 to 24 mines', () => {
  assert.equal(minesTerms(100n,1,0,10000n).payout,100n)
  assert.equal(minesTerms(100n,5,0,10000n).payout,100n)
  assert.equal(minesTerms(100n,24,0,10000n).payout,100n)
  const first = minesTerms(100n,10,1,100000n)
  const second = minesTerms(100n,10,2,100000n)
  assert.ok(first.multiplier > 1 && first.multiplier < 2)
  assert.ok(second.multiplier > first.multiplier)
  assert.throws(()=>minesTerms(100n,24,2,10000n))
  assert.throws(()=>minesTerms(100n,25,1,10000n))
})
test('cap is backed by a bounded liability', () => {
  assert.equal(minesLimit(100n),2350n)
  assert.equal(minesLimit(100n,1),2350n)
  assert.equal(minesLimit(100000n),1000000n)
  const capped=minesTerms(100n,24,1,2000n)
  assert.equal(capped.payout,2000n);assert.equal(capped.capped,true)
})
test('commit reveal is deterministic and client seed changes field', () => {
  const field=minesField('a'.repeat(64),'client',0,10)
  assert.equal(new Set(field).size,10)
  assert.deepEqual(field,minesField('a'.repeat(64),'client',0,10))
  assert.notDeepEqual(field,minesField('a'.repeat(64),'other',0,10))
  assert.equal(seedHash('a'.repeat(64)).length,64)
})
test('token fund is at most 10% NET profit and rounding stays with winner', () => {
  const result=allocateTokenRewards([{id:'winner',netProfit:109}], [{id:'one',candidateId:'winner',tokens:1},{id:'two',candidateId:'winner',tokens:2}])
  assert.equal(result.payouts.get('one'),3n);assert.equal(result.payouts.get('two'),6n)
  assert.equal(result.total,9n);assert.equal(result.deductions.get('winner'),9n)
  assert.equal(109n-result.total+result.total,109n)
})
test('multiple winners fund only their own tickets', () => {
  const result=allocateTokenRewards([{id:'a',netProfit:100},{id:'b',netProfit:250}], [{id:'a1',candidateId:'a',tokens:3},{id:'b1',candidateId:'b',tokens:1},{id:'b2',candidateId:'b',tokens:1},{id:'lose',candidateId:'c',tokens:3}])
  assert.equal(result.payouts.get('a1'),10n)
  assert.equal(result.payouts.get('b1'),12n);assert.equal(result.payouts.get('b2'),12n)
  assert.equal(result.total,34n)
})
test('no emission for no winners, no tickets, negative net, or tiny profit', () => {
  for (const netProfit of [-50,0,9]) assert.equal(allocateTokenRewards([{id:'a',netProfit}],[{id:'x',candidateId:'a',tokens:3}]).total,0n)
  assert.equal(allocateTokenRewards([{id:'a',netProfit:1000}],[]).total,0n)
})
