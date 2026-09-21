import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getToCall } from '../server/utils/pokerBetting'
import { createPredefinedDeck, createStandardDeck } from '../server/utils/pokerDeck'
import {
  applyOnlineRoomAction,
  canListOnlineRoomPublicly,
  createOnlineRoom,
  generateOnlineRoomCode,
  isValidOnlineRoomCode,
  joinOnlineRoom,
  leaveOnlineRoom,
  normalizeOnlineRoomCode,
  releasePendingOnlineRoomPlayers,
  setOnlineRoomConnected,
  setOnlineRoomReady,
  startOnlineRoomHand,
  toPlayerSafeOnlineRoomState,
  type OnlineRoomState
} from '../server/utils/pokerOnlineRoom'

function deck() {
  return createPredefinedDeck(createStandardDeck().availableCards)
}

function createRoom(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC'): OnlineRoomState {
  return createOnlineRoom({
    roomId: 'online-room-1',
    roomCode: 'abc234',
    ownerId: 'owner',
    ownerStack: 100,
    ownerSeat: 2,
    smallBlind: 5,
    bigBlind: 10,
    visibility,
    createdAt: '2026-09-21T00:00:00.000Z',
    ...(visibility === 'PRIVATE' ? { privateJoinSecret: 'join-secret' } : {})
  })
}

function joined(room: OnlineRoomState, playerId = 'player-2', seat?: number): OnlineRoomState {
  return joinOnlineRoom(room, { playerId, seat, stack: 100, joinSecret: room.privateJoinSecret })
}

function readyRoom(room: OnlineRoomState): OnlineRoomState {
  let next = joined(room)
  next = setOnlineRoomReady(next, 'owner', true)
  next = setOnlineRoomReady(next, 'player-2', true)
  return next
}

function runningRoom(room = readyRoom(createRoom())): OnlineRoomState {
  return startOnlineRoomHand(room, { deck: deck() })
}

function finishedRoom(room: OnlineRoomState): OnlineRoomState {
  const table = room.pokerTable
  const hand = table.currentHand!
  return Object.freeze({
    ...room,
    status: 'WAITING' as const,
    pokerTable: Object.freeze({
      ...table,
      currentHand: Object.freeze({
        ...hand,
        street: 'FINISHED' as const,
        currentActor: null,
        bettingRoundComplete: true
      })
    })
  })
}

test('creates a public online room with the owner seated', () => {
  const room = createRoom()
  assert.equal(room.type, 'ONLINE')
  assert.equal(room.visibility, 'PUBLIC')
  assert.equal(room.status, 'WAITING')
  assert.equal(room.ownerId, 'owner')
  assert.equal(room.pokerTable.players[0]!.playerId, 'owner')
  assert.equal(room.pokerTable.players[0]!.seat, 2)
  assert.equal(room.privateJoinSecret, undefined)
})

test('creates a private room with server-only join authorization', () => {
  const room = createRoom('PRIVATE')
  assert.equal(room.visibility, 'PRIVATE')
  assert.equal(room.privateJoinSecret, 'join-secret')
  assert.equal(canListOnlineRoomPublicly(room), false)
  assert.throws(() => joinOnlineRoom(room, { playerId: 'wrong-secret', stack: 100, joinSecret: 'wrong' }), /private room join secret/)
  assert.equal(joined(room, 'private-player').pokerTable.players.length, 2)
})

test('room code is normalized, validated, and immutable in the model', () => {
  assert.equal(normalizeOnlineRoomCode(' abc234 '), 'ABC234')
  assert.equal(isValidOnlineRoomCode('abc234'), true)
  assert.equal(isValidOnlineRoomCode('ABC2345'), false)
  assert.equal(isValidOnlineRoomCode('AB0123'), false)
  const room = createRoom()
  assert.equal(room.roomCode, 'ABC234')
  assert.equal('setRoomCode' in room, false)
})

test('online codes keep a plain resolver-compatible format for future HOME/ONLINE lookup', () => {
  const generated = generateOnlineRoomCode()
  assert.equal(generated.length, 6)
  assert.equal(isValidOnlineRoomCode(generated), true)
  assert.equal(normalizeOnlineRoomCode(generated.toLowerCase()), generated)
})

test('join uses a free seat when omitted and rejects duplicate players', () => {
  const room = createRoom()
  const next = joined(room)
  assert.equal(next.pokerTable.players.find(player => player.playerId === 'player-2')!.seat, 1)
  assert.throws(() => joined(next), /already in this online room/)
})

test('explicit duplicate seats and a seventh player are rejected', () => {
  let room = createRoom()
  room = joined(room, 'p1', 1)
  assert.throws(() => joined(room, 'p2', 1), /occupied/)
  for (const [index, seat] of [3, 4, 5, 6].entries()) room = joined(room, `p${index + 2}`, seat)
  assert.equal(room.pokerTable.players.length, 6)
  assert.throws(() => joined(room, 'p7'), /full/)
})

test('leave between hands immediately frees a seat', () => {
  const room = joined(createRoom())
  const next = leaveOnlineRoom(room, 'player-2')
  assert.equal(next.pokerTable.players.length, 1)
  assert.equal(next.pokerTable.seats.find(seat => seat.seat === 1)!.playerId, null)
  assert.equal(next.status, 'WAITING')
})

test('leave during a hand preserves the internal hand and records a pending departure', () => {
  const room = runningRoom()
  const hand = room.pokerTable.currentHand!
  const contributions = hand.players.map(player => [player.playerId, player.contribution])
  const next = leaveOnlineRoom(room, 'player-2')
  assert.equal(next.status, 'IN_HAND')
  assert.deepEqual(next.pendingLeaves, ['player-2'])
  assert.equal(next.pokerTable.currentHand, hand)
  assert.deepEqual(next.pokerTable.currentHand!.players.map(player => [player.playerId, player.contribution]), contributions)
  assert.equal(next.pokerTable.players.find(player => player.playerId === 'player-2')!.connected, false)
})

test('pending departure is released only after the hand is over', () => {
  const leaving = leaveOnlineRoom(runningRoom(), 'player-2')
  assert.throws(() => releasePendingOnlineRoomPlayers(leaving), /active hand/)
  const next = releasePendingOnlineRoomPlayers(finishedRoom(leaving))
  assert.equal(next.pokerTable.players.some(player => player.playerId === 'player-2'), false)
  assert.deepEqual(next.pendingLeaves, [])
})

test('owner leave transfers ownership by ascending seat order', () => {
  let room = createRoom()
  room = joined(room, 'seat-1', 1)
  room = joined(room, 'seat-3', 3)
  const next = leaveOnlineRoom(room, 'owner')
  assert.equal(next.ownerId, 'seat-1')
  assert.equal(next.pokerTable.players.some(player => player.playerId === 'owner'), false)
})

test('owner leaving the only seated player closes the room', () => {
  const next = leaveOnlineRoom(createRoom(), 'owner')
  assert.equal(next.status, 'CLOSED')
  assert.equal(next.ownerId, null)
  assert.equal(next.pokerTable.players.length, 0)
  assert.throws(() => joined(next), /closed/)
})

test('owner leave during a hand transfers ownership without removing the hand player', () => {
  const next = leaveOnlineRoom(runningRoom(), 'owner')
  assert.equal(next.ownerId, 'player-2')
  assert.equal(next.pokerTable.currentHand!.players.some(player => player.playerId === 'owner'), true)
})

test('ready state delegates to PokerTableState and increments room version', () => {
  const room = joined(createRoom())
  const next = setOnlineRoomReady(room, 'owner', true, { expectedRoomVersion: room.roomVersion })
  assert.equal(next.pokerTable.players.find(player => player.playerId === 'owner')!.ready, true)
  assert.equal(next.roomVersion, room.roomVersion + 1)
})

test('sitting-out and connected metadata delegate to the table state', () => {
  let room = joined(createRoom())
  room = setOnlineRoomReady(room, 'player-2', true)
  assert.equal(room.pokerTable.players.find(player => player.playerId === 'player-2')!.ready, true)
  room = setOnlineRoomConnected(room, 'player-2', false)
  assert.equal(room.pokerTable.players.find(player => player.playerId === 'player-2')!.connected, false)
  room = setOnlineRoomConnected(room, 'player-2', true)
  assert.equal(room.pokerTable.players.find(player => player.playerId === 'player-2')!.connected, true)
})

test('start delegates to PokerTableState and preserves table state version semantics', () => {
  const room = readyRoom(createRoom())
  const next = startOnlineRoomHand(room, {
    deck: deck(),
    expectedRoomVersion: room.roomVersion,
    expectedStateVersion: room.pokerTable.stateVersion
  })
  assert.equal(next.status, 'IN_HAND')
  assert.ok(next.pokerTable.currentHand)
  assert.equal(next.pokerTable.stateVersion, room.pokerTable.stateVersion + 1)
  assert.equal(next.roomVersion, room.roomVersion)
})

test('betting action delegates without changing room membership version', () => {
  const room = runningRoom()
  const actor = room.pokerTable.currentHand!.players.find(player => player.seat === room.pokerTable.currentHand!.currentActor)!
  const action = getToCall(room.pokerTable.currentHand!, actor.playerId) > 0 ? 'call' as const : 'check' as const
  const next = applyOnlineRoomAction(room, {
    action: { playerId: actor.playerId, type: action },
    expectedRoomVersion: room.roomVersion,
    expectedStateVersion: room.pokerTable.stateVersion
  })
  assert.equal(next.roomVersion, room.roomVersion)
  assert.equal(next.pokerTable.stateVersion, room.pokerTable.stateVersion + 1)
})

test('room version rejects stale membership operations without changing the source', () => {
  const room = createRoom()
  assert.throws(() => joinOnlineRoom(room, { playerId: 'stale', stack: 100, expectedRoomVersion: 99 }), /does not match/)
  assert.equal(room.pokerTable.players.length, 1)
  assert.equal(room.roomVersion, 1)
})

test('source room state remains immutable across joins and actions', () => {
  const room = runningRoom()
  const before = room
  const actor = room.pokerTable.currentHand!.players.find(player => player.seat === room.pokerTable.currentHand!.currentActor)!
  const next = applyOnlineRoomAction(room, { action: { playerId: actor.playerId, type: 'call' } })
  assert.equal(room, before)
  assert.notEqual(next, room)
  assert.notEqual(next.pokerTable, room.pokerTable)
  assert.equal(room.pokerTable.currentHand!.currentActor, actor.seat)
})

test('safe room snapshot hides private secret and all internal hand data', () => {
  const room = runningRoom(readyRoom(createRoom('PRIVATE')))
  const viewer = room.pokerTable.players[0]!.playerId
  const safe = toPlayerSafeOnlineRoomState(room, viewer)
  assert.equal('privateJoinSecret' in safe, false)
  assert.equal('pendingLeaves' in safe, false)
  assert.equal('deck' in safe.pokerTable.currentHand!, false)
  assert.equal('burnCards' in safe.pokerTable.currentHand!, false)
  assert.equal(safe.pokerTable.currentHand!.players.find(player => player.playerId === viewer)!.holeCards.length, 2)
})

test('safe room snapshot hides opponents hole cards but exposes public board/table data', () => {
  const room = runningRoom()
  const viewer = room.pokerTable.players[0]!.playerId
  const safe = toPlayerSafeOnlineRoomState(room, viewer)
  const opponents = safe.pokerTable.currentHand!.players.filter(player => player.playerId !== viewer)
  assert.equal(opponents.every(player => player.holeCards.length === 0), true)
  assert.deepEqual(safe.pokerTable.currentHand!.board, [])
  assert.equal(safe.roomCode, 'ABC234')
})

test('public listing excludes private and closed rooms', () => {
  assert.equal(canListOnlineRoomPublicly(createRoom()), true)
  assert.equal(canListOnlineRoomPublicly(createRoom('PRIVATE')), false)
  assert.equal(canListOnlineRoomPublicly(leaveOnlineRoom(createRoom(), 'owner')), false)
})

test('room membership supports all six seats and preserves immutable room metadata', () => {
  let room = createRoom()
  const originalCode = room.roomCode
  for (const [index, seat] of [1, 3, 4, 5, 6].entries()) room = joined(room, `player-${index + 1}`, seat)
  assert.equal(room.pokerTable.players.length, 6)
  assert.equal(room.maxPlayers, 6)
  assert.equal(room.roomCode, originalCode)
  assert.equal(room.roomVersion, 6)
})

test('stale table action version is still rejected through the room wrapper', () => {
  const room = runningRoom()
  const actor = room.pokerTable.currentHand!.players.find(player => player.seat === room.pokerTable.currentHand!.currentActor)!
  assert.throws(() => applyOnlineRoomAction(room, {
    action: { playerId: actor.playerId, type: 'call' },
    expectedStateVersion: room.pokerTable.stateVersion - 1
  }), /Expected table state version/)
})

test('starting a room with too few ready players remains waiting without consuming the deck', () => {
  const room = createRoom()
  const supplied = deck()
  const before = supplied.remainingCount
  const next = startOnlineRoomHand(room, { deck: supplied })
  assert.equal(next.status, 'WAITING')
  assert.equal(next.pokerTable.currentHand, null)
  assert.equal(supplied.remainingCount, before)
})

test('starting after a finished hand reconciles pending departures before the next hand', () => {
  const room = runningRoom()
  const leaving = leaveOnlineRoom(room, 'player-2')
  const next = startOnlineRoomHand(finishedRoom(leaving), { deck: deck() })
  assert.equal(next.pokerTable.players.some(player => player.playerId === 'player-2'), false)
  assert.equal(next.pendingLeaves.length, 0)
  assert.equal(next.status, 'WAITING')
})

test('private room authorization data is never included in a safe snapshot', () => {
  const room = createRoom('PRIVATE')
  const safe = toPlayerSafeOnlineRoomState(room)
  assert.deepEqual(Object.keys(safe).sort(), [
    'createdAt',
    'maxPlayers',
    'ownerId',
    'pokerTable',
    'roomCode',
    'roomId',
    'roomVersion',
    'status',
    'type',
    'visibility'
  ])
})
