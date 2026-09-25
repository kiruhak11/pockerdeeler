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
  markDraining?: (roomId: string) => Promise<boolean>
  decision?: (id: string, code: string) => any
  random?: () => number
} = {}) {
  const calls: Array<{ method: string; args: any[] }> = []
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = []
  const bots = overrides.bots ?? [bot('online-bot-01')]
  const rooms = overrides.rooms ?? []
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    listBots: async () => bots,
    listPublicRooms: async () => rooms as any,
    countBotCreatedRooms: async () => 0,
    cleanupBotCreatedRooms: async () => 0,
    markRoomDraining: async roomId => overrides.markDraining?.(roomId) ?? true,
    findSeatedRoom: async id => overrides.findRoom?.(id) ?? null,
    getRoom: async (id, code) => {
      const result = overrides.getRoom?.(id, code) ?? room()
      return (result && typeof result === 'object' && 'room' in result ? result : { room: result }) as any
    },
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
    now: () => now, random: overrides.random ?? (() => 0),
    log: (event, fields) => { logs.push({ event, fields }) }
  })
  return { orchestrator, calls, logs, setNow: (value: number) => { now = value }, adapter }
}

function codedConflict() {
  return Object.assign(new Error('stale room state'), { code: 'CONFLICT' })
}

function seatedRoom(botId: string, overrides: Record<string, unknown> = {}) {
  const base = room({ ownerId: botId, ...overrides })
  return {
    ...base,
    pokerTable: {
      ...base.pokerTable,
      players: [{ playerId: botId, seat: 1, stack: 1_000, connected: true, ready: false, sittingOut: false }],
      seats: [{ seat: 1, playerId: botId }]
    }
  }
}

test('feature flag defaults off and disabled tick performs no bot or room work', async () => {
  assert.equal(readOnlinePokerBotOrchestratorConfig({}).enabled, false)
  assert.equal(readOnlinePokerBotOrchestratorConfig({}).startingStack, 5_000)
  assert.equal(readOnlinePokerBotOrchestratorConfig({}).highStartingStack, 10_000)
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

test('a bot-only room drains after one activity window, without leaving an active hand', async () => {
  const botId = 'online-bot-01-id'
  const h = harness({
    findRoom: () => 'AB2345',
    getRoom: () => seatedRoom(botId)
  })
  await h.orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'leave'), false)

  h.setNow(1_000_000 + 5 * 60_000 + 1)
  await h.orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'leave').length, 1)
})

test('bot-only idle timeout waits for the active hand to finish', async () => {
  const botId = 'online-bot-01-id'
  let snapshot = seatedRoom(botId, {
    pokerTable: {
      ...room().pokerTable,
      players: [{ playerId: botId, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false }],
      seats: [{ seat: 1, playerId: botId }],
      currentHand: { handId: 'active-hand', street: 'FLOP', currentActor: 2 }
    }
  })
  const h = harness({ findRoom: () => 'AB2345', getRoom: () => snapshot })
  await h.orchestrator.tick()
  h.setNow(1_000_000 + 5 * 60_000 + 1)
  await h.orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'leave'), false)

  snapshot = seatedRoom(botId, { pokerTable: { ...room().pokerTable, players: [{ playerId: botId, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false }], seats: [{ seat: 1, playerId: botId }] } })
  await h.orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'leave').length, 1)
})

test('draining marker blocks a bot selected from a stale candidate list and prevents rejoin', async () => {
  const botId = 'online-bot-01-id'
  let draining = false
  let seated = true
  const candidates = [{ code: 'AB2345', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }]
  const h = harness({
    findRoom: () => seated ? 'AB2345' : null,
    rooms: candidates,
    getRoom: () => ({ room: seated ? seatedRoom(botId) : room(), ...(draining ? { draining: true } : {}) }),
    markDraining: async () => { draining = true; return true }
  })
  await h.orchestrator.tick()
  h.setNow(1_000_000 + 5 * 60_000 + 1)
  await h.orchestrator.tick()
  assert.equal(draining, true)
  assert.equal(h.calls.filter(call => call.method === 'leave').length, 1)
  seated = false
  await h.orchestrator.tick()
  assert.equal(h.calls.filter(call => call.method === 'join').length, 0)
})

test('a stale full public room candidate does not block joining the next candidate', async () => {
  const identity = bot('online-bot-01')
  const fullRoom = room({ pokerTable: { ...room().pokerTable, players: Array.from({ length: 6 }, (_, index) => ({
    playerId: `human-${index}`, seat: index + 1, stack: 1_000, connected: true, ready: false, sittingOut: false
  })) } })
  const rooms = [
    { code: 'AB2345', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 },
    { code: 'CD3456', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(1).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }
  ]
  const h = harness({ bots: [identity], rooms, getRoom: (_id, code) => code === 'AB2345' ? fullRoom : room() })
  const attemptedCodes: string[] = []
  let seatedCode: string | null = null
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    findSeatedRoom: async () => seatedCode,
    joinRoom: async (_id, code) => {
      attemptedCodes.push(code)
      if (code === 'AB2345') throw codedConflict()
      seatedCode = code
      return { room: room() } as any
    }
  }
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'worker', token: '1:worker', leaseKey: `lease:${botKey}` }),
    renew: async () => true,
    release: async () => true
  }, random: () => 0 })

  await subject.tick()

  assert.deepEqual(attemptedCodes, ['AB2345', 'CD3456'])
  assert.equal(seatedCode, 'CD3456')
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
  assert.deepEqual(input, { visibility: 'PUBLIC', startingStack: 10_000, smallBlind: 5, bigBlind: 10 })
})

test('bot-created room uses a funded 5k stack when the 10k choice is unavailable', async () => {
  const first = { ...bot('online-bot-01'), balance: 5_000 }
  const second = { ...bot('online-bot-02', 'bot-2-id'), balance: 5_000 }
  const h = harness({ bots: [first, second], random: () => 0.9 })
  await h.orchestrator.tick()
  const created = h.calls.filter(call => call.method === 'create')
  assert.equal(created.length, 1)
  assert.equal(created[0]!.args[1].startingStack, 5_000)
})

test('bot cannot create an unfunded room below 5k despite a legacy 1k config', async () => {
  const first = { ...bot('online-bot-01'), balance: 4_999 }
  const second = { ...bot('online-bot-02', 'bot-2-id'), balance: 4_999 }
  const h = harness({ bots: [first, second] })
  await h.orchestrator.tick()
  assert.equal(h.calls.some(call => call.method === 'create'), false)
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

test('stale ready conflict refreshes and treats an already-ready seat as complete', async () => {
  const identity = bot('online-bot-01')
  let current = seatedRoom(identity.id)
  let readyCalls = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    ready: async (...args) => {
      readyCalls += 1
      h.calls.push({ method: 'ready', args })
      current = { ...current, pokerTable: { ...current.pokerTable, players: [{ ...current.pokerTable.players[0], ready: true }] } }
      throw codedConflict()
    }
  }
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(readyCalls, 1)
  assert.equal(h.calls.filter(call => call.method === 'ready').length, 1)
})

test('stale ready conflict retries once after refresh when readiness is still needed', async () => {
  const identity = bot('online-bot-01')
  let current = seatedRoom(identity.id)
  let readyCalls = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    ready: async (...args) => {
      readyCalls += 1
      h.calls.push({ method: 'ready', args })
      if (readyCalls === 1) throw codedConflict()
      current = { ...current, pokerTable: { ...current.pokerTable, players: [{ ...current.pokerTable.players[0], ready: true }] } }
      return { room: current } as any
    }
  }
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(readyCalls, 2)
  assert.equal(current.pokerTable.players[0].ready, true)
})

test('stale start conflict refreshes and does not start a hand twice', async () => {
  const identity = bot('online-bot-01')
  let current = room({ ownerId: identity.id, pokerTable: { ...room().pokerTable, stateVersion: 4, players: [
    { playerId: identity.id, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false },
    { playerId: 'human', seat: 2, stack: 1_000, connected: true, ready: true, sittingOut: false }
  ] } })
  let starts = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    startHand: async (...args) => {
      starts += 1
      h.calls.push({ method: 'start', args })
      current = { ...current, pokerTable: { ...current.pokerTable, handSequence: current.pokerTable.handSequence + 1, currentHand: { handId: 'already-started', street: 'FINISHED' } } }
      throw codedConflict()
    }
  }
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(starts, 1)
})

test('lost lease during conflict recovery prevents retry', async () => {
  const identity = bot('online-bot-01')
  const current = seatedRoom(identity.id)
  let calls = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    ready: async (...args) => { calls += 1; h.calls.push({ method: 'ready', args }); throw codedConflict() }
  }
  let botRenewals = 0
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }),
    renew: async lease => lease.botKey === '__scheduler__' || ++botRenewals < 2,
    release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(calls, 1)
})

test('leave conflict observes an already-released seat and never repeats cash-out', async () => {
  const identity = { ...bot('online-bot-01'), balance: 0 }
  let current = seatedRoom(identity.id)
  current = { ...current, pokerTable: { ...current.pokerTable, players: [{ ...current.pokerTable.players[0], stack: 0 }] } }
  let leaves = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    leave: async (...args) => {
      leaves += 1
      h.calls.push({ method: 'leave', args })
      current = { ...current, pokerTable: { ...current.pokerTable, players: [] } }
      throw codedConflict()
    }
  }
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => 1_010_000, random: () => 0 })
  await subject.tick()
  assert.equal(leaves, 1)
})

test('stale join refresh sees the existing seat and never debits twice', async () => {
  const identity = bot('online-bot-01')
  let current = room()
  let joins = 0
  let seated = false
  const h = harness({ bots: [identity], rooms: [{ code: 'AB2345', playerCount: 1, maxPlayers: 6, status: 'WAITING', createdAt: new Date(0).toISOString(), startingStack: 1_000, smallBlind: 5, bigBlind: 10 }], getRoom: () => current })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    joinRoom: async (...args) => {
      joins += 1
      h.calls.push({ method: 'join', args })
      const joined = seatedRoom(identity.id)
      seated = true
      current = { ...current, pokerTable: joined.pokerTable }
      throw codedConflict()
    },
    findSeatedRoom: async () => seated ? 'AB2345' : null
  }
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, random: () => 0 })
  await subject.tick()
  assert.equal(joins, 1)
  assert.equal(h.calls.filter(call => call.method === 'join').length, 1)
})

function actionableBotRoom(botId: string) {
  const own = { playerId: botId, seat: 1, stack: 1_000, streetContribution: 0, status: 'ACTIVE', holeCards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' }] }
  const hand = { handId: 'hand-action', street: 'PREFLOP', currentActor: 1, board: [], pot: 15, currentBet: 10, dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 2, smallBlind: 5, bigBlind: 10, players: [own], turnDeadlineAt: 2_000_000 }
  const base = room({ ownerId: botId, pokerTable: { ...room().pokerTable, stateVersion: 7, currentHand: hand, players: [{ playerId: botId, seat: 1, stack: 1_000, connected: true, ready: true, sittingOut: false }] } })
  return base
}

test('bot action conflict refreshes and retries once with the same action id when turn remains legal', async () => {
  const identity = bot('online-bot-01')
  let current = actionableBotRoom(identity.id)
  const actionIds: string[] = []
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current,
    decision: () => ({ room: current, legalActions: ['check'], toCall: 0, minRaiseTo: 20, raiseReopened: true }) })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    getDecisionSnapshot: async () => ({ room: current, legalActions: ['check'], toCall: 0, minRaiseTo: 20, raiseReopened: true } as any),
    action: async (...args) => {
      actionIds.push(args[2].actionId)
      h.calls.push({ method: 'action', args })
      if (actionIds.length === 2) current = { ...current, pokerTable: { ...current.pokerTable, currentHand: { ...current.pokerTable.currentHand, currentActor: 2 } } }
      if (actionIds.length === 1) throw codedConflict()
      return {}
    }
  }
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(actionIds.length, 2)
  assert.equal(actionIds[0], actionIds[1])
})

test('timeout winning the action race is treated as stale without retry', async () => {
  const identity = bot('online-bot-01')
  let current = actionableBotRoom(identity.id)
  let actions = 0
  const h = harness({ bots: [identity], findRoom: () => 'AB2345', getRoom: () => current,
    decision: () => ({ room: current, legalActions: ['check'], toCall: 0, minRaiseTo: 20, raiseReopened: true }) })
  const adapter: OnlinePokerBotOrchestratorAdapter = {
    ...h.adapter,
    action: async (...args) => {
      actions += 1
      h.calls.push({ method: 'action', args })
      current = { ...current, pokerTable: { ...current.pokerTable, currentHand: { ...current.pokerTable.currentHand, currentActor: 2 } } }
      throw codedConflict()
    }
  }
  let now = 1_000_000
  const subject = new OnlinePokerBotOrchestrator({ config: baseConfig({ maxBotCreatedRooms: 0 }), adapter, lease: {
    acquire: async botKey => ({ botKey, ownerId: 'w', token: '1', leaseKey: 'lease' }), renew: async () => true, release: async () => true
  }, now: () => now, random: () => 0 })
  await subject.tick()
  now += 10_000
  await subject.tick()
  assert.equal(actions, 1)
})
