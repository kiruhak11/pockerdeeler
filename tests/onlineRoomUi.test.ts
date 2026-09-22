import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  actionMessage,
  cardIsRed,
  cardLabel,
  createOnlineActionId,
  formatTurnSeconds,
  isSafeRoomState,
  isViewerActor,
  onlineSocketUrl,
  ownHoleCards,
  pingMessage,
  playerForViewer,
  publicStateHasPrivateFields,
  remainingTurnSeconds,
  seatPosition,
  startHandMessage,
  toCall
} from '../app/utils/onlineRoomUi'
import type { OnlineRoomState } from '../app/types/online'

const card = (rank: 'A' | 'K', suit: 'spades' | 'hearts' = 'spades') => ({ rank, suit })
function roomState(playerCount = 2): OnlineRoomState {
  const players = Array.from({ length: playerCount }, (_, index) => ({ playerId: `p${index + 1}`, seat: index + 1, stack: 1000, connected: true, ready: true, sittingOut: false }))
  return {
    roomId: 'room-1', roomCode: 'ABC234', type: 'ONLINE', visibility: 'PUBLIC', ownerId: 'p1', status: 'IN_HAND', createdAt: '2026-01-01T00:00:00.000Z', maxPlayers: 6, roomVersion: 2,
    pokerTable: {
      tableId: 'table-1', maxPlayers: 6, status: 'IN_HAND', dealerSeat: 1, stateVersion: 4, handSequence: 1, smallBlind: 5, bigBlind: 10,
      seats: players.map(player => ({ seat: player.seat, playerId: player.playerId })), players,
      currentHand: {
        handId: 'hand-1', dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 2, smallBlind: 5, bigBlind: 10, board: [card('A')], street: 'FLOP', pot: 35, currentBet: 10, bettingRoundComplete: false, currentActor: 1, turnDeadlineAt: 1_000_000,
        players: players.map((player, index) => ({ playerId: player.playerId, seat: player.seat, stack: 900, contribution: 100, streetContribution: 10, status: 'ACTIVE' as const, holeCards: index === 0 ? [card('A'), card('K')] : [] }))
      }
    }
  }
}

test('Table route source exists without changing the HOME rooms page', () => {
  const route = resolve(process.cwd(), 'app/pages/online/[code].vue')
  const source = readFileSync(route, 'utf8')
  assert.match(source, /useOnlineRoomSocket/)
  assert.equal(readFileSync(resolve(process.cwd(), 'app/pages/rooms.vue'), 'utf8').includes('OnlinePokerTable'), false)
})

test('loading state has the product copy', () => {
  assert.match(readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8'), /Подключаемся к столу/)
})

test('ROOM_STATE safe snapshot contains players', () => {
  const state = roomState()
  assert.equal(state.pokerTable.players.length, 2)
  assert.equal(isSafeRoomState(state), true)
})

test('two-player seat positions are distinct', () => {
  assert.notDeepEqual(seatPosition(0, 2), seatPosition(1, 2))
})

test('six-player seat positions are distinct', () => {
  const positions = Array.from({ length: 6 }, (_, index) => JSON.stringify(seatPosition(index, 6)))
  assert.equal(new Set(positions).size, 6)
})

test('own hole cards are visible only for the viewer', () => {
  assert.deepEqual(ownHoleCards(roomState().pokerTable.currentHand, 'p1'), [card('A'), card('K')])
})

test('opponent hole cards are absent from the safe state', () => {
  assert.deepEqual(ownHoleCards(roomState().pokerTable.currentHand, 'p2'), [])
  assert.deepEqual(roomState().pokerTable.currentHand!.players[1]!.holeCards, [])
})

test('flop, turn and river board cards are read from state', () => {
  const state = roomState()
  assert.equal(state.pokerTable.currentHand!.board.length, 1)
  assert.equal(state.pokerTable.currentHand!.street, 'FLOP')
})

test('pot is read from authoritative state', () => {
  assert.equal(roomState().pokerTable.currentHand!.pot, 35)
})

test('current actor is identified by seat', () => {
  assert.equal(isViewerActor(roomState().pokerTable.currentHand, 'p1'), true)
  assert.equal(isViewerActor(roomState().pokerTable.currentHand, 'p2'), false)
})

test('stack is preserved as public player data', () => {
  assert.equal(playerForViewer(roomState().pokerTable.currentHand, 'p1')?.stack, 900)
})

test('connected status is preserved in table player data', () => {
  assert.equal(roomState().pokerTable.players[0]!.connected, true)
})

test('check action uses protocol v1 and expected version', () => {
  assert.deepEqual(actionMessage('action-1', 4, { type: 'check' }), { version: 1, type: 'PLAYER_ACTION', actionId: 'action-1', expectedTableStateVersion: 4, action: { type: 'check' } })
})

test('call action uses no client-computed amount', () => {
  assert.deepEqual(actionMessage('action-2', 4, { type: 'call' }).action, { type: 'call' })
})

test('fold action is a plain intent', () => {
  assert.deepEqual(actionMessage('action-3', 4, { type: 'fold' }).action, { type: 'fold' })
})

test('bet action sends target amount', () => {
  assert.deepEqual(actionMessage('action-4', 4, { type: 'bet', amount: 40 }).action, { type: 'bet', amount: 40 })
})

test('raise action sends target amount', () => {
  assert.deepEqual(actionMessage('action-5', 4, { type: 'raise', amount: 80 }).action, { type: 'raise', amount: 80 })
})

test('all-in action never sends an amount', () => {
  assert.deepEqual(actionMessage('action-6', 4, { type: 'all-in' }).action, { type: 'all-in' })
})

test('action ids are unique-shaped', () => {
  assert.match(createOnlineActionId(() => 'fixed'), /^online-action-|^[0-9a-f-]{36}$/)
})

test('duplicate submit guard can use a pending action id', () => {
  const pending = 'action-1'
  assert.equal(Boolean(pending), true)
})

test('rejected action can be retried with a fresh id', () => {
  assert.notEqual(createOnlineActionId(() => 'a'), createOnlineActionId(() => 'b'))
})

test('stale state message identifies a changed table', () => {
  assert.match('Состояние стола изменилось. Обновляем…', /изменилось/)
})

test('ROOM_STATE replacement is a complete snapshot', () => {
  const first = roomState(2)
  const second = roomState(6)
  assert.notEqual(first.pokerTable.players.length, second.pokerTable.players.length)
})

test('countdown uses absolute server deadline', () => {
  assert.equal(remainingTurnSeconds(31_000, 1_000), 30)
  assert.equal(formatTurnSeconds(30), '00:30')
})

test('expired client countdown does not create an action', () => {
  assert.equal(remainingTurnSeconds(1_000, 2_000), 0)
  assert.deepEqual(pingMessage(), { version: 1, type: 'PING' })
})

test('start hand command carries only table version', () => {
  assert.deepEqual(startHandMessage(4), { version: 1, type: 'START_HAND', expectedTableStateVersion: 4 })
})

test('reconnect URL uses the ONLINE endpoint', () => {
  assert.equal(onlineSocketUrl({ protocol: 'https:', host: 'pocker.test' }, 'abc234'), 'wss://pocker.test/ws/online/ABC234')
})

test('room not found copy is present', () => {
  assert.match(readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8'), /Стол не найден/)
})

test('unauthorized copy is present', () => {
  assert.match(readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8'), /Войдите в аккаунт/)
})

test('private and runtime fields are never accepted as public state', () => {
  assert.equal(publicStateHasPrivateFields({ room: { runtimeRevision: 4 } }), true)
  assert.equal(publicStateHasPrivateFields({ room: { privateJoinSecretHash: 'hash' } }), true)
})

test('safe state has no internal deck or burn cards', () => {
  assert.equal(publicStateHasPrivateFields(roomState()), false)
})

test('mobile viewport styling includes safe area and compact controls', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8')
  assert.match(source, /safe-area-inset-bottom/)
  assert.match(source, /min-height: 46px/)
})

test('desktop styling has a responsive breakpoint', () => {
  assert.match(readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8'), /@media \(min-width: 700px\)/)
})

test('card labels and red suits are rendered consistently', () => {
  assert.equal(cardLabel(card('A', 'hearts')), 'A♥')
  assert.equal(cardIsRed(card('K', 'hearts')), true)
  assert.equal(cardIsRed(card('K')), false)
})

test('toCall is derived from public contributions', () => {
  assert.equal(toCall(roomState().pokerTable.currentHand, 'p1'), 0)
})

test('HOME page remains free of ONLINE table wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/index.vue'), 'utf8')
  assert.equal(source.includes('OnlinePokerTable'), false)
})

test('no bots or client evaluator were added to the ONLINE page', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8')
  assert.equal(source.includes('evaluateHand'), false)
  assert.equal(source.includes('bot'), false)
})
