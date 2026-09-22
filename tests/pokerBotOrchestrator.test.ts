import test from 'node:test'
import assert from 'node:assert/strict'
import { OnlinePokerBotOrchestrator, readOnlinePokerBotOrchestratorConfig, type OnlinePokerBotOrchestratorAdapter } from '../server/services/onlinePokerBotOrchestrator'
import type { PersistentBotIdentity } from '../server/services/botIdentityService'

const baseConfig = (overrides: Partial<ReturnType<typeof readOnlinePokerBotOrchestratorConfig>> = {}) => ({
  enabled: true, minActiveBots: 1, maxActiveBots: 1, maxBotsPerRoom: 3, maxBotCreatedRooms: 1,
  tickIntervalMs: 1_000, startingStack: 1_000, smallBlind: 5, bigBlind: 10,
  quickJoinProbability: 1, createRoomProbability: 1, ...overrides
})

function bot(botKey: string, id = `${botKey}-id`): PersistentBotIdentity {
  return {
    id, botKey, nickname: botKey, isBot: true, botEnabled: true, skillTier: 'REGULAR', playStyle: 'BALANCED',
    balance: 10_000, tableRating: 1_000, tableHandsPlayed: 0, tableHandsWon: 0,
    predictionRating: 1_000, leaderboardVisible: true
  }
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    roomId: 'room-id', roomCode: 'AB2345', visibility: 'PUBLIC', ownerId: 'human-id', status: 'WAITING',
    roomVersion: 1, maxPlayers: 6,
    pokerTable: { tableId: 'table-id', maxPlayers: 6, seats: [], players: [], currentHand: null, dealerSeat: null,
      status: 'WAITING', stateVersion: 1, handSequence: 0, finalizedHandId: null, finalizedHand: null, smallBlind: 5, bigBlind: 10 },
    ...overrides
  }
}

function harness(overrides: {
  bots?: readonly PersistentBotIdentity[]
  rooms?: readonly any[]
  findRoom?: (id: string) => string | null
  getRoom?: (id: string, code: string) => any
  decision?: (id: string, code: string) => any
} = {}) {
  const calls: Array<{ method: string; args: any[] }> = []
  const bots = overrides.bots ?? [bot('online-bot-01')]
  const rooms = overrides.rooms ?? []
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    listBots: async () => bots,
    listPublicRooms: async () => rooms as any,
    countBotCreatedRooms: async () => 0,
    cleanupBotCreatedRooms: async () => 0,
    findSeatedRoom: async id => overrides.findRoom?.(id) ?? null,
    getRoom: async (id, code) => ({ room: overrides.getRoom?.(id, code) ?? room() } as any),
    getDecisionSnapshot: async (id, code) => overrides.decision?.(id, code) as any,
    createRoom: async (...args) => { calls.push({ method: 'create', args }); return { room: room({ ownerId: args[0] }) } as any },
    joinRoom: async (...args) => { calls.push({ method: 'join', args }); return { room: room() } as any },
    ready: async (...args) => { calls.push({ method: 'ready', args }); return { room: args[3] } as any },
    startHand: async (...args) => { calls.push({ method: 'start', args }); return { room: room() } as any },
    action: async (...args) => { calls.push({ method: 'action', args }); return {} },
    leave: async (...args) => { calls.push({ method: 'leave', args }); return { room: room() } as any }
  }
  const held = new Map<string, any>()
  const lease = {
    acquire: async (botKey: string) => {
      if (held.has(botKey)) return null
      const item = { botKey, ownerId: 'worker', token: `1:${botKey}`, leaseKey: `lease:${botKey}` }
      held.set(botKey, item)
      return item
    },
    renew: async (item: any) => held.get(item.botKey)?.token === item.token,
    release: async (item: any) => held.delete(item.botKey)
  }
  let now = 1_000_000
  const orchestrator = new OnlinePokerBotOrchestrator({
    config: baseConfig(), adapter, lease,
    now: () => now, random: () => 0,
    log: () => {}
  })
  return { orchestrator, calls, setNow: (value: number) => { now = value }, adapter }
}

test('feature flag defaults off and disabled tick performs no bot or room work', async () => {
  assert.equal(readOnlinePokerBotOrchestratorConfig({}).enabled, false)
  const h = harness()
  const disabled = new OnlinePokerBotOrchestrator({
    config: baseConfig({ enabled: false }), adapter: h.adapter,
    lease: { acquire: async () => { throw new Error('lease must not be touched') }, renew: async () => false, release: async () => false }
  })
  await disabled.tick()
  assert.equal(h.calls.length, 0)
})

test('bot joins an old public room through adapter join and respects room bot cap', async () => {
  const h = harness({
    rooms: [{ code: 'AB2345', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }],
    getRoom: () => room()
  })
  await h.orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'join').length, 1)
  assert.equal(h.calls.find(call => call.method === 'join')!.args[1], 'AB2345')
})

test('a human room is not filled beyond the configured bot limit', async () => {
  const ids = ['online-bot-01-id', 'online-bot-02-id', 'online-bot-03-id']
  const occupied = room({ pokerTable: { ...room().pokerTable, players: ids.map((playerId, index) => ({ playerId, seat: index + 1, stack: 1_000, connected: true, ready: false, sittingOut: false })) } })
  const h = harness({
    bots: [bot('online-bot-01'), bot('online-bot-02', 'online-bot-02-id'), bot('online-bot-03', 'online-bot-03-id')],
    rooms: [{ code: 'AB2345', playerCount: 3, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }],
    getRoom: () => occupied
  })
  const orchestrator = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotsPerRoom: 2, maxBotCreatedRooms: 0 }), adapter: h.adapter,
    lease: { acquire: async (botKey: string) => ({ botKey, ownerId: 'worker', token: botKey, leaseKey: botKey }), renew: async () => true, release: async () => true }, random: () => 0 })
  await orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'join'), false)
})

test('a human joining a bot-created room restores the regular bot cap', async () => {
  const bots = [bot('online-bot-01'), bot('online-bot-02', 'online-bot-02-id'), bot('online-bot-03', 'online-bot-03-id')]
  const ownerId = bots[0]!.id
  const occupied = room({ ownerId, pokerTable: { ...room().pokerTable, players: [
    ...bots.slice(0, 2).map((item, index) => ({ playerId: item.id, seat: index + 1, stack: 1_000, connected: true, ready: false, sittingOut: false })),
    { playerId: 'human-user', seat: 3, stack: 1_000, connected: true, ready: false, sittingOut: false }
  ] } })
  const h = harness({ bots, rooms: [{ code: 'AB2345', playerCount: 3, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }], getRoom: () => occupied })
  const orchestrator = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotsPerRoom: 2, maxBotCreatedRooms: 0 }), adapter: h.adapter,
    lease: { acquire: async botKey => ({ botKey, ownerId: 'worker', token: botKey, leaseKey: botKey }), renew: async () => true, release: async () => true }, random: () => 0 })
  await orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'join'), false)
})

test('private room candidate is never joined or created as a private room', async () => {
  const h = harness({
    rooms: [{ code: 'AB2345', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }],
    getRoom: () => room({ visibility: 'PRIVATE' })
  })
  await h.orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'join'), false)
  assert.equal(h.calls.some(call => call.method === 'create' && call.args[1].visibility !== 'PUBLIC'), false)
})

test('bot-created room is public, uses bounded settings, and is limited per tick', async () => {
  const h = harness({ bots: [bot('online-bot-01'), bot('online-bot-02', 'bot-2-id')] })
  await h.orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'create').length, 1)
  const input = h.calls.find(call => call.method === 'create')!.args[1]
  assert.deepEqual(input, { visibility: 'PUBLIC', startingStack: 1_000, smallBlind: 5, bigBlind: 10 })
})

test('broke bots cannot join or create a room', async () => {
  const h = harness({ bots: [bot('online-bot-01')] })
  const poor = { ...bot('online-bot-01'), balance: 999 }
  const adapter = { ...h.adapter, listBots: async () => [poor] }
  const orchestrator = new OnlinePokerBotOrchestrator({ config: baseConfig(), adapter, lease: {
    acquire: async (botKey: string) => ({ botKey, ownerId: 'w', token: '1:w', leaseKey: 'l' }), renew: async () => true, release: async () => true
  }, random: () => 0 })
  await orchestrator.tick()
  assert.equal(h.calls.length, 0)
})

test('a seated broke bot cashes out zero and leaves only after the hand is over', async () => {
  const seatedBot = bot('online-bot-01')
  const seated = { playerId: seatedBot.id, seat: 1, stack: 0, connected: true, ready: true, sittingOut: false }
  let currentRoom = room({ ownerId: seatedBot.id, pokerTable: { ...room().pokerTable, players: [seated], currentHand: { handId: 'active', street: 'RIVER', currentActor: null, players: [] } } })
  const h = harness({ bots: [seatedBot], findRoom: () => 'AB2345', getRoom: () => currentRoom })
  const orchestrator = new OnlinePokerBotOrchestrator({ config: baseConfig(), adapter: h.adapter,
    lease: { acquire: async botKey => ({ botKey, ownerId: 'w', token: '1:w', leaseKey: 'l' }), renew: async () => true, release: async () => true }, random: () => 0 })
  await orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'leave').length, 0)
  currentRoom = room({ ownerId: seatedBot.id, pokerTable: { ...room().pokerTable, players: [seated], currentHand: { handId: 'active', street: 'FINISHED', currentActor: null, players: [] } } })
  await orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'leave').length, 1)
  assert.equal(h.calls.some(call => call.method === 'join' || call.method === 'create'), false)
})

test('bot action uses strategy output, action id, table version and human-like delay', async () => {
  const own = { playerId: 'online-bot-01-id', seat: 1, stack: 1_000, streetContribution: 0, status: 'ACTIVE', holeCards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' }] }
  const hand = { handId: 'hand-id', street: 'PREFLOP', currentActor: 1, board: [], pot: 15, currentBet: 10, dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 2, smallBlind: 5, bigBlind: 10, players: [own], turnDeadlineAt: Date.now() + 30_000 }
  const seatedRoom = room({ ownerId: own.playerId, pokerTable: { ...room().pokerTable, stateVersion: 7, currentHand: hand, players: [{ playerId: own.playerId, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false }] } })
  const h = harness({ findRoom: () => 'AB2345', getRoom: () => seatedRoom, decision: () => ({ room: seatedRoom, legalActions: ['check'], toCall: 0, minRaiseTo: 20, raiseReopened: true }) })
  await h.orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'action'), false)
  h.setNow(1_010_000)
  await h.orchestrator.tick()
  const action = h.calls.find(call => call.method === 'action')
  assert.ok(action)
  assert.match(action!.args[2].actionId, /^[0-9a-f-]{36}$/i)
  assert.equal(action!.args[2].expectedTableStateVersion, 7)
  assert.equal(action!.args[2].action.type, 'check')
})
