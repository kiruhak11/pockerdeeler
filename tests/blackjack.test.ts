import test from 'node:test'
import assert from 'node:assert/strict'
import { BLACKJACK_RANKS, BLACKJACK_SUITS, blackjackHandValue, blackjackPayout, createBlackjackDeck, dealerShouldHit, playDealerHand, resolveBlackjackOutcome, resolveInitialBlackjack, type BlackjackCard } from '../server/utils/blackjack'
import { blackjackStartSchema } from '../server/utils/blackjackValidation'

const card = (rank: BlackjackCard['rank'], suit: BlackjackCard['suit'] = 'S'): BlackjackCard => ({ rank, suit, code: `${rank}${suit}` })

test('blackjack totals count faces as ten and aces as the best legal value', () => {
  assert.deepEqual(blackjackHandValue([card('10'), card('7')]), { total: 17, soft: false, natural: false, bust: false })
  assert.equal(blackjackHandValue([card('A'), card('K')]).total, 21)
  assert.equal(blackjackHandValue([card('A'), card('K')]).natural, true)
  assert.equal(blackjackHandValue([card('A'), card('6')]).soft, true)
  assert.deepEqual(blackjackHandValue([card('A'), card('6')]), { total: 17, soft: true, natural: false, bust: false })
  assert.equal(blackjackHandValue([card('A'), card('A')]).total, 12)
  assert.equal(blackjackHandValue([card('A'), card('A'), card('9')]).total, 21)
  assert.equal(blackjackHandValue([card('A'), card('A'), card('9')]).soft, true)
  assert.equal(blackjackHandValue([card('A'), card('9'), card('5')]).total, 15)
  assert.equal(blackjackHandValue([card('A'), card('A'), card('A'), card('8')]).total, 21)
  assert.equal(blackjackHandValue([card('A'), card('A'), card('9'), card('K')]).soft, false)
  assert.equal(blackjackHandValue([card('10'), card('K'), card('5')]).bust, true)
})

test('the dealer draws below 17 and stands on hard and soft 17', () => {
  assert.equal(dealerShouldHit([card('10'), card('6')]), true)
  assert.equal(dealerShouldHit([card('10'), card('7')]), false)
  assert.equal(dealerShouldHit([card('A'), card('6')]), false)
  const completed = playDealerHand([card('10'), card('5')], () => card('2'))
  assert.deepEqual(completed.map(item => item.rank), ['10', '5', '2'])
  const softSeventeen = playDealerHand([card('A'), card('6')], () => { throw new Error('soft 17 must stand') })
  assert.equal(softSeventeen.length, 2)
})

test('outcomes cover win, loss, push, busts, and natural blackjack precedence', () => {
  assert.equal(resolveBlackjackOutcome([card('10'), card('9')], [card('10'), card('7')]), 'WIN')
  assert.equal(resolveBlackjackOutcome([card('10'), card('8')], [card('10'), card('9')]), 'LOSE')
  assert.equal(resolveBlackjackOutcome([card('10'), card('8')], [card('K'), card('8')]), 'PUSH')
  assert.equal(resolveBlackjackOutcome([card('10'), card('K'), card('2')], [card('10'), card('8')]), 'LOSE')
  assert.equal(resolveBlackjackOutcome([card('10'), card('9')], [card('K'), card('8'), card('5')]), 'WIN')
  assert.equal(resolveBlackjackOutcome([card('A'), card('K')], [card('9'), card('7')]), 'BLACKJACK')
  assert.equal(resolveBlackjackOutcome([card('A'), card('K')], [card('A'), card('Q')]), 'PUSH')
  assert.equal(resolveBlackjackOutcome([card('10'), card('9')], [card('A'), card('K')]), 'LOSE')
  assert.equal(resolveBlackjackOutcome([card('7'), card('7'), card('7')], [card('10'), card('8')]), 'WIN', 'three-card 21 is not a natural blackjack')
})

test('initial natural deals settle immediately for player, dealer, and mutual blackjack', () => {
  assert.equal(resolveInitialBlackjack([card('A'), card('K')], [card('10'), card('7')]), 'BLACKJACK')
  assert.equal(resolveInitialBlackjack([card('A'), card('K')], [card('A'), card('Q')]), 'PUSH')
  assert.equal(resolveInitialBlackjack([card('10'), card('9')], [card('A'), card('K')]), 'LOSE')
  assert.equal(resolveInitialBlackjack([card('7'), card('7'), card('7')], [card('10'), card('7')]), null)
})

test('gross returns include stake and natural blackjack receives exact 3:2', () => {
  assert.equal(blackjackPayout('WIN', 100n), 200n)
  assert.equal(blackjackPayout('PUSH', 100n), 100n)
  assert.equal(blackjackPayout('BLACKJACK', 100n), 250n)
  assert.equal(blackjackPayout('WIN', 200n), 400n, 'a double-down win returns doubled stake plus equal profit')
  assert.equal(blackjackPayout('PUSH', 200n), 200n)
  assert.equal(blackjackPayout('LOSE', 200n), 0n)
  assert.equal(blackjackPayout('LOSE', 100n), 0n)
  assert.throws(() => blackjackPayout('BLACKJACK', 99n), /even number/)
  assert.equal(blackjackStartSchema.safeParse({ stake: 99, requestId: 'ac34d264-1dbd-4ca3-a3d7-522c65991d82' }).success, false)
  assert.equal(blackjackStartSchema.safeParse({ stake: 100, requestId: 'ac34d264-1dbd-4ca3-a3d7-522c65991d82' }).success, true)
})

test('each round gets one standard 52-card deck', () => {
  const deck = createBlackjackDeck(() => 0)
  assert.equal(deck.length, 52)
  assert.equal(new Set(deck.map(item => item.code)).size, 52)
  assert.notDeepEqual(deck.map(item => item.code), BLACKJACK_SUITS.flatMap(suit => BLACKJACK_RANKS.map(rank => `${rank}${suit}`)))
})
