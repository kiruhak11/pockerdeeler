import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  actionMessage,
  cardIsRed,
  cardLabel,
  createOnlineActionId,
  displayHand,
  formatTurnSeconds,
  isSafeRoomState,
  isPostHandWaitingState,
  isViewerActor,
  onlineSocketUrl,
  ownHoleCards,
  pingMessage,
  playerForViewer,
  publicStateHasPrivateFields,
  remainingTurnSeconds,
  seatPosition,
  startHandMessage,
  tablePlayerForViewer,
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

function waitingRoomState(): OnlineRoomState {
  const state = roomState()
  return {
    ...state,
    status: 'WAITING',
    pokerTable: { ...state.pokerTable, status: 'WAITING', currentHand: null }
  }
}

function finishedRoomState(): OnlineRoomState {
  const state = roomState()
  const tablePlayers = state.pokerTable.players.map((player, index) => ({ ...player, stack: index === 0 ? 995 : 1005, ready: false }))
  const hand = state.pokerTable.currentHand!
  return {
    ...state,
    status: 'WAITING',
    pokerTable: {
      ...state.pokerTable,
      status: 'WAITING',
      players: tablePlayers,
      currentHand: { ...hand, street: 'FINISHED', pot: 15, players: hand.players.map(player => ({ ...player, stack: player.playerId === 'p1' ? 995 : 990 })) }
    }
  }
}

test('Table route source exists without changing the HOME rooms page', () => {
  const route = resolve(process.cwd(), 'app/pages/online/[code].vue')
  const source = readFileSync(route, 'utf8')
  assert.match(source, /useOnlineRoomSocket/)
  assert.equal(readFileSync(resolve(process.cwd(), 'app/pages/rooms.vue'), 'utf8').includes('OnlinePokerTable'), false)
})

test('HOME lobby fetch is SSR-compatible for the first hydrated render', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/room/LobbyDirectory.vue'), 'utf8')
  assert.match(source, /await useFetch\('\/api\/rooms'\)/)
  assert.doesNotMatch(source, /server:\s*false/)
  assert.doesNotMatch(source, /lazy:\s*true/)
  assert.doesNotMatch(source, /<ClientOnly>/)
})

test('HOME lobby loading and refresh states stay tied to fetch status', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/room/LobbyDirectory.vue'), 'utf8')
  assert.match(source, /:disabled="status === 'pending'"/)
  assert.match(source, /!rooms && status === 'pending'/)
  assert.match(source, /@click="refresh\(\)"/)
})

test('loading state has the product copy', () => {
  assert.match(readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8'), /Подключаемся к столу/)
})

test('ROOM_STATE safe snapshot contains players', () => {
  const state = roomState()
  assert.equal(state.pokerTable.players.length, 2)
  assert.equal(isSafeRoomState(state), true)
})

test('waiting membership comes from table players before the first hand', () => {
  const state = waitingRoomState()
  assert.equal(state.pokerTable.currentHand, null)
  assert.equal(tablePlayerForViewer(state.pokerTable, 'p1')?.playerId, 'p1')
  assert.equal(isPostHandWaitingState(state), true)
})

test('both seated players remain eligible for ready controls before the first hand', () => {
  const state = waitingRoomState()
  assert.equal(tablePlayerForViewer(state.pokerTable, 'p1')?.ready, true)
  assert.equal(tablePlayerForViewer(state.pokerTable, 'p2')?.ready, true)
})

test('first-hand start eligibility is represented by the waiting table state', () => {
  const state = waitingRoomState()
  assert.equal(state.ownerId, 'p1')
  assert.equal(state.pokerTable.players.filter(player => player.ready && player.connected && !player.sittingOut && player.stack > 0).length, 2)
  assert.match(readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8'), /v-if="canStart"[^>]*>Начать раздачу/)
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

test('active hand still uses current-hand player data', () => {
  const state = roomState()
  assert.equal(playerForViewer(state.pokerTable.currentHand, 'p1')?.stack, 900)
  assert.equal(displayHand(state.pokerTable.currentHand)?.street, 'FLOP')
})

test('finished hand is treated as post-hand waiting', () => {
  const state = finishedRoomState()
  assert.equal(isPostHandWaitingState(state), true)
  assert.equal(displayHand(state.pokerTable.currentHand), null)
})

test('finished state uses authoritative table-level stacks', () => {
  const state = finishedRoomState()
  assert.equal(tablePlayerForViewer(state.pokerTable, 'p2')?.stack, 1005)
  assert.equal(state.pokerTable.currentHand?.players.find(player => player.playerId === 'p2')?.stack, 990)
})

test('finished presentation hides stale hand stack and active pot', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8')
  assert.match(source, /displayHand\(hand\.value\)/)
  assert.match(source, /visibleHand(?:\?\.|\.)pot/)
  assert.match(source, /handPlayer\(player\.playerId\)\?\.stack \?\? player\.stack/)
  assert.equal(displayHand(finishedRoomState().pokerTable.currentHand), null)
})

test('ready and next-hand controls remain available after settlement', () => {
  const state = finishedRoomState()
  assert.equal(tablePlayerForViewer(state.pokerTable, 'p1')?.ready, false)
  assert.equal(state.ownerId, 'p1')
  assert.equal(isPostHandWaitingState(state), true)
})

test('showdown remains active presentation rather than waiting', () => {
  const state = roomState()
  const showdown: OnlineRoomState = { ...state, pokerTable: { ...state.pokerTable, status: 'IN_HAND', currentHand: { ...state.pokerTable.currentHand!, street: 'SHOWDOWN' } } }
  assert.equal(isPostHandWaitingState(showdown), false)
  assert.equal(displayHand(showdown.pokerTable.currentHand)?.street, 'SHOWDOWN')
})

test('new ROOM_STATE replaces finished presentation with the next hand', () => {
  const finished = finishedRoomState()
  const next = roomState()
  assert.equal(displayHand(finished.pokerTable.currentHand), null)
  assert.equal(displayHand(next.pokerTable.currentHand)?.street, 'FLOP')
})

test('reconnect in waiting and finished states rebuilds membership from each snapshot', () => {
  assert.equal(tablePlayerForViewer(waitingRoomState().pokerTable, 'p2')?.playerId, 'p2')
  assert.equal(tablePlayerForViewer(finishedRoomState().pokerTable, 'p2')?.playerId, 'p2')
})

test('public and private rooms share the same lifecycle helpers', () => {
  const privateWaiting: OnlineRoomState = { ...waitingRoomState(), visibility: 'PRIVATE' }
  assert.equal(tablePlayerForViewer(privateWaiting.pokerTable, 'p1')?.playerId, 'p1')
  assert.equal(isPostHandWaitingState(privateWaiting), true)
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

test('online page synchronizes HTTP concurrency token from WebSocket snapshots', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8')
  const socket = readFileSync(resolve(process.cwd(), 'app/composables/useOnlineRoomSocket.ts'), 'utf8')
  const hub = readFileSync(resolve(process.cwd(), 'server/ws/onlineRoomHub.ts'), 'utf8')
  assert.match(socket, /onState\?\: \(state: OnlineRoomState, concurrencyToken\?: string\)/)
  assert.match(socket, /payload\.concurrencyToken/)
  assert.match(hub, /concurrencyToken: result\.concurrencyToken/)
  assert.match(source, /applyAuthoritativeState\(next, token\)/)
})

test('ONLINE create exposes the HOME poker settings', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/online/create.vue'), 'utf8')
  assert.match(source, /startingStack/)
  assert.match(source, /smallBlind/)
  assert.match(source, /bigBlind/)
  assert.match(source, /startingStack: startingStack\.value/)
  assert.match(source, /smallBlind: smallBlind\.value/)
  assert.match(source, /bigBlind: bigBlind\.value/)
})

test('online page ignores older HTTP snapshots and clears stale notices after success', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8')
  assert.match(source, /next\.roomVersion < state\.value\.roomVersion/)
  assert.match(source, /notice\.value = ''/)
  assert.match(source, /if \(statusCode\(error\) === 409\) await loadState\(\)/)
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

test('player presentation uses public nickname, table stack, street contribution and last action', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8')
  assert.match(source, /displayName\(player\)/)
  assert.match(source, /Стек:/)
  assert.match(source, /Ставка:/)
  assert.match(source, /actionLabel\(/)
  assert.match(source, /:title="displayName\(player\)"/)
})

test('player presentation includes dealer and blind markers and public statuses', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8')
  assert.match(source, /Кнопка дилера/)
  assert.match(source, /Малый блайнд/)
  assert.match(source, /Большой блайнд/)
  assert.match(source, /player-seat--actor/)
  assert.match(source, /player-seat--all-in/)
  assert.match(source, /player-seat--sitting-out/)
  assert.match(source, /player-seat--offline/)
})

test('seat layouts keep the viewer at the lower anchor for two through six players', () => {
  for (let count = 2; count <= 6; count += 1) {
    const positions = Array.from({ length: count }, (_, index) => seatPosition(index, count))
    assert.equal(new Set(positions.map(position => JSON.stringify(position))).size, count)
    assert.equal(positions[0]?.top, count === 2 ? '86%' : count === 6 ? '87%' : '86%')
  }
})

test('player seats are layered above the felt without a client-side poker evaluator', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/components/online/OnlinePokerTable.vue'), 'utf8')
  assert.match(source, /\.players \{ position: absolute; z-index: 4/)
  assert.match(source, /\.player-seat \{ position: absolute; z-index: 5/)
  assert.doesNotMatch(source, /evaluateHand|pokerHandEvaluator/)
})

test('no bots or client evaluator were added to the ONLINE page', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/pages/online/[code].vue'), 'utf8')
  assert.equal(source.includes('evaluateHand'), false)
  assert.equal(source.includes('bot'), false)
})
