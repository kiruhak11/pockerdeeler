import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerUser, issueUserAuthToken } from '../server/services/userAccountService'
import { PrismaClient } from '@prisma/client'
import type { RoomState } from '../server/services/roomService'
import type { AccountUser } from '../app/types/account'
import type { DealerPredictionState, PredictionViewerState } from '../app/types/prediction'

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3106'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Tests must never target production')
assert.ok(process.env.DATABASE_URL?.includes(':55439/') || process.env.DATABASE_URL?.includes('_test'), 'Use an isolated test database')
const db = new PrismaClient()
const codes: string[] = [], userIds: string[] = []
type Joined = { playerId: string; participantId: string; playerSessionToken: string }
type Created = { roomCode: string; dealerSecret: string }
type StateResponse = { state: RoomState }

async function request<T>(path: string, body?: unknown, token?: string, expected = 200): Promise<T> {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  // Exercise the real production limiter without disabling it for a large suite.
  if (path === '/api/rooms/create' && response.status === 429 && expected === 200) {
    const seconds = Number(response.headers.get('Retry-After'))
    assert.ok(seconds > 0 && seconds <= 60)
    await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000))
    return request<T>(path, body, token, expected)
  }
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`)
  return data as T
}
async function create(extra: Record<string, unknown> = {}) {
  const room = await request<Created>('/api/rooms/create', { name: 'Integration test', startingStack: 100, smallBlind: 5, bigBlind: 10, maxPlayers: 8, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true, ...extra })
  codes.push(room.roomCode)
  return room
}
async function account() {
  const result = await registerUser({ username: `test_${randomUUID().slice(0, 12)}`, password: 'Integration-only-password' })
  userIds.push(result.user.id)
  return result
}
async function setWalletBalance(userId: string, balance: number) {
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { balance } }),
    db.userWallet.update({ where: { userId }, data: { balance: BigInt(balance), version: { increment: 1 } } })
  ])
}
const join = (room: Created, name: string, extra: Record<string, unknown> = {}, expected = 200) => request<Joined>(`/api/rooms/${room.roomCode}/join`, { name, ...extra }, undefined, expected)
const state = (r: Created) => request<RoomState>(`/api/rooms/${r.roomCode}/state`, undefined, r.dealerSecret)
const command = (r: Created, path: string, extra: Record<string, unknown> = {}, expected = 200) => request<StateResponse>(`/api/rooms/${r.roomCode}/${path}`, { dealerSecret: r.dealerSecret, ...extra }, undefined, expected)
const action = (r: Created, p: Joined, type: string, amount = 0, expected = 200, key = randomUUID()) => request<StateResponse & { action: { id: string; status: string } }>(`/api/rooms/${r.roomCode}/action`, { playerId: p.playerId, token: p.playerSessionToken, type, amount, clientRequestId: key }, undefined, expected)
const leave = (r: Created, p: Joined) => request(`/api/rooms/${r.roomCode}/leave`, { participantId: p.participantId, token: p.playerSessionToken })
const away = (r: Created, token: string, expected = 200) => request<StateResponse>(`/api/rooms/${r.roomCode}/away`, { token }, undefined, expected)
const resume = (r: Created, token: string, expected = 200) => request<Joined & StateResponse>(`/api/rooms/${r.roomCode}/resume`, { token }, undefined, expected)

async function playToShowdown(room: Created, players: Map<string, Joined>) {
  for (let step = 0; step < 24; step += 1) {
    const current = await state(room)
    const betting = current.currentHand?.bettingState
    if (betting?.phase === 'showdown') return current
    if (betting?.phase === 'reveal') {
      await command(room, 'reveal-cards', { handId: current.currentHand!.id, street: betting.street })
      continue
    }
    const actorId = current.currentSession?.currentPlayerId
    const actor = actorId ? players.get(actorId) : undefined
    const player = actorId ? current.players.find(item => item.id === actorId) : undefined
    assert.ok(actor && player, 'Expected an authenticated current player')
    await action(room, actor, player.currentBet < (current.currentHand?.currentBet || 0) ? 'call' : 'check')
  }
  assert.fail('Hand did not reach showdown within the expected number of actions')
}

async function assertRoomTransfersBalanced(roomCode: string) {
  const room = await db.room.findUniqueOrThrow({ where: { code: roomCode } })
  const [walletEntries, roomEntries] = await Promise.all([
    db.walletLedgerEntry.findMany({ where: { roomId: room.id }, select: { transferId: true, entryType: true, amount: true } }),
    db.roomLedgerEntry.findMany({ where: { roomId: room.id }, select: { transferId: true, entryType: true, amount: true } })
  ])
  const transfers = new Map<string, { sum: bigint; emission: boolean }>()
  for (const entry of [...walletEntries, ...roomEntries]) {
    const current = transfers.get(entry.transferId) || { sum: 0n, emission: false }
    current.sum += entry.amount
    current.emission ||= entry.entryType === 'SYSTEM_GRANT' || entry.entryType === 'ACCOUNT_OPENING_GRANT'
    transfers.set(entry.transferId, current)
  }
  for (const [transferId, transfer] of transfers) {
    if (!transfer.emission) assert.equal(transfer.sum, 0n, `Unbalanced transfer ${transferId}`)
  }
}

after(async () => {
  await db.room.deleteMany({ where: { code: { in: codes } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
  await db.$disconnect()
})

test('private rooms enforce password and never publish state or hashes to strangers', async () => {
  const r = await create({ accessMode: 'private', password: 'secret-room' })
  await join(r, 'stranger', {}, 403)
  await join(r, 'stranger', { password: 'wrong' }, 403)
  const p = await join(r, 'member', { password: 'secret-room' })
  await request(`/api/rooms/${r.roomCode}/state`, undefined, undefined, 403)
  const s = await request<RoomState>(`/api/rooms/${r.roomCode}/state`, undefined, p.playerSessionToken)
  assert.ok(!JSON.stringify(s).includes('Hash'))
  const list = await request<{ code: string; hasPassword: boolean }[]>('/api/rooms')
  assert.equal(list.find(i => i.code === r.roomCode)?.hasPassword, true)
})

test('membership policy: accounts-only, guests-only and mixed', async () => {
  const user = await account(), accounts = await create({ playerPolicy: 'accounts' })
  await join(accounts, 'guest', {}, 403)
  await join(accounts, 'ignored', { authToken: user.token })
  const guests = await create({ playerPolicy: 'guests' })
  await join(guests, 'ignored', { authToken: user.token }, 403)
  await join(guests, 'guest')
  const mixed = await create()
  await join(mixed, 'bad-token', { authToken: 'invalid-token-xxxxxxxx' }, 401)
  await join(mixed, 'ignored', { authToken: user.token }, 409)
})

test('leaving frees the nickname, disables old token, and permits a fresh seat', async () => {
  const r = await create(), a = await join(r, 'Same Name')
  await join(r, 'Keeper')
  await leave(r, a)
  const b = await join(r, 'same name')
  assert.notEqual(a.playerId, b.playerId)
  await request(`/api/rooms/${r.roomCode}/state`, undefined, a.playerSessionToken, 403)
  assert.equal((await state(r)).players.filter(p => p.participantId).length, 2)
})

test('capacity is transaction-safe and the last departure deletes the room', async () => {
  const r = await create({ maxPlayers: 2 })
  const a = await join(r, 'A'), b = await join(r, 'B')
  await join(r, 'C', {}, 409)
  await leave(r, a); await leave(r, b)
  await request(`/api/rooms/${r.roomCode}/info`, undefined, undefined, 404)
})

test('legacy unconditional bonus endpoints are retired', async () => {
  const u = await account()
  await request('/api/auth/daily-bonus', { token: u.token }, undefined, 410)
  await request('/api/auth/reset-balance', { token: u.token }, undefined, 410)
})

test('account seating remains separate from the reward wallet', async () => {
  const u = await account(), r = await create()
  const a = await join(r, 'ignored', { authToken: u.token })
  await join(r, 'Guest')
  assert.equal((await state(r)).players.find(p => p.id === a.playerId)?.stack, 5000)
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: u.token })).user.balance, 0)
  await command(r, 'start-game')
  await db.user.update({ where: { id: u.user.id }, data: { lastDailyBonusAt: null } })
  await request('/api/auth/daily-bonus', { token: u.token }, undefined, 410)
  await leave(r, a)
  const fresh = await join(r, 'ignored', { authToken: u.token })
  assert.equal((await state(r)).players.find(p => p.id === fresh.playerId)?.status, 'waiting')
})

test('full hand: blinds, authentication, idempotency, undo, four streets, payout exactly once', async () => {
  const r = await create(), a = await join(r, 'A'), b = await join(r, 'B')
  await request(`/api/rooms/${r.roomCode}/start-game`, { dealerSecret: 'wrong-secret' }, undefined, 403)
  await command(r, 'start-game'); await command(r, 'start-hand')
  let s = await state(r)
  assert.equal(s.currentHand?.pot, 15)
  assert.equal(s.currentSession?.currentPlayerId, a.playerId)
  await action(r, b, 'check', 0, 409)
  await action(r, { ...b, playerSessionToken: a.playerSessionToken }, 'check', 0, 403)
  await command(r, 'finish-hand', {}, 409)
  const key = randomUUID(), first = await action(r, a, 'call', 0, 200, key)
  const duplicate = await action(r, a, 'call', 0, 200, key)
  assert.equal(first.action.id, duplicate.action.id)
  assert.equal(duplicate.state.currentHand?.pot, 20)
  await command(r, 'undo')
  s = await state(r)
  assert.equal(s.currentHand?.pot, 15)
  assert.equal(s.currentSession?.currentPlayerId, a.playerId)
  await action(r, a, 'call'); await action(r, b, 'check')
  s = await state(r)
  assert.equal(s.currentHand?.bettingState?.phase, 'reveal')
  assert.equal(s.currentSession?.currentPlayerId, undefined)
  await action(r, a, 'check', 0, 409)
  for (const street of ['preflop', 'flop', 'turn']) {
    const payload = { handId: s.currentHand!.id, street }
    await command(r, 'reveal-cards', payload)
    await command(r, 'reveal-cards', payload, 409)
    s = await state(r)
    assert.equal(s.currentSession?.currentPlayerId, b.playerId)
    assert.equal(s.currentHand?.currentBet, 0)
    await action(r, b, 'check'); await action(r, a, 'check')
    s = await state(r)
  }
  assert.equal(s.currentHand?.bettingState?.phase, 'showdown')
  await command(r, 'finish-hand')
  await command(r, 'distribute-pot', { winners: [a.playerId] })
  await command(r, 'distribute-pot', { winners: [a.playerId] }, 409)
  s = await state(r)
  assert.equal(s.players.reduce((sum, p) => sum + p.stack, 0), 200)
  assert.equal(s.players.find(p => p.id === a.playerId)?.stack, 110)
  assert.equal(s.lastDistribution?.deltas.find(p => p.playerId === a.playerId)?.delta, 10)
})

test('dealer approval and kick advance turn; a late join waits until next hand', async () => {
  const r = await create({ requireDealerActionApproval: true })
  const a = await join(r, 'A'), b = await join(r, 'B'), c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  const pending = await action(r, a, 'call')
  assert.equal(pending.action.status, 'pending')
  assert.equal(pending.state.currentHand?.pot, 15)
  await command(r, 'dealer-action', { pendingActionId: pending.action.id, decision: 'approve' })
  assert.equal((await state(r)).currentSession?.currentPlayerId, b.playerId)
  await command(r, 'kick-player', { playerId: b.playerId })
  assert.equal((await state(r)).currentSession?.currentPlayerId, c.playerId)
  const again = await join(r, 'B')
  assert.equal((await state(r)).players.find(p => p.id === again.playerId)?.status, 'waiting')
  await action(r, b, 'call', 0, 403)
  await command(r, 'undo', {}, 409)
})

test('departed all-in account receives its main pot, cannot claim early bonus, and can rejoin after payout', async () => {
  const u = await account()
  await setWalletBalance(u.user.id, 40)
  const r = await create(), a = await join(r, 'A', { authToken: u.token }), b = await join(r, 'B'), c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  await action(r, a, 'all-in'); await action(r, b, 'call'); await action(r, c, 'all-in'); await action(r, b, 'call')
  await leave(r, a)
  await request('/api/auth/daily-bonus', { token: u.token }, undefined, 410)
  await join(r, 'A', { authToken: u.token }, 409)
  for (const street of ['preflop', 'flop', 'turn']) {
    const s = await state(r)
    await command(r, 'reveal-cards', { handId: s.currentHand!.id, street })
  }
  await command(r, 'finish-hand')
  await command(r, 'distribute-pot', { winners: [a.playerId, b.playerId], potWinners: { '1': [a.playerId], '2': [b.playerId] } })
  const result = await state(r)
  const paidOutWallet = (await request<{ user: AccountUser }>('/api/auth/me', { token: u.token })).user.balance
  const achievementBonus = Number((await db.walletLedgerEntry.aggregate({ where: { wallet: { userId: u.user.id }, entryType: 'ACHIEVEMENT_REWARD' }, _sum: { amount: true } }))._sum.amount || 0n)
  assert.equal(result.players.reduce((sum, p) => sum + p.stack, 0) + paidOutWallet - achievementBonus, 240)
  assert.equal(paidOutWallet - achievementBonus, 120)
  const again = await join(r, 'A', { authToken: u.token })
  assert.equal((await state(r)).players.find(p => p.id === again.playerId)?.stack, paidOutWallet)
})

test('WebSocket requires membership, broadcasts changes, and revokes a kicked player', async () => {
  const r = await create(), a = await join(r, 'A')
  await join(r, 'B')
  const socket = new WebSocket(base.replace('http', 'ws') + `/ws/room/${r.roomCode}`)
  const events: { type: string; state?: RoomState }[] = []
  socket.onmessage = e => events.push(JSON.parse(String(e.data)))
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(events.length, 0)
  socket.send(JSON.stringify({ type: 'authenticate', token: a.playerSessionToken }))
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    assert.fail('WebSocket update timed out')
  }
  try {
    await waitFor(() => events.some(e => e.type === 'room:joined'))
    await command(r, 'start-game'); await command(r, 'start-hand')
    await waitFor(() => events.some(e => e.state?.currentHand?.pot === 15))
    let closeCode = 0
    socket.onclose = e => { closeCode = e.code }
    await command(r, 'kick-player', { playerId: a.playerId })
    await waitFor(() => closeCode !== 0)
    assert.equal(closeCode, 4003)
  } finally { socket.close() }
})

test('account can reserve a private seat, recover from a new login and leave completely', async () => {
  const u = await account(), other = await account()
  const r = await create({ accessMode: 'private', password: 'reserved-secret', maxPlayers: 2, allowLateJoin: false })
  const a = await join(r, 'A', { authToken: u.token, password: 'reserved-secret' })
  await join(r, 'B', { password: 'reserved-secret' })
  await away(r, u.token)
  assert.equal((await state(r)).players.find(p => p.id === a.playerId)?.isAway, true)
  await away(r, other.token, 403)
  await resume(r, other.token, 403)
  await resume(r, a.playerSessionToken, 401)
  await join(r, 'C', { password: 'reserved-secret' }, 409)
  const memberships = await request<{ roomCode: string; isAway: boolean }[]>('/api/auth/rooms', { token: u.token })
  assert.deepEqual(memberships.map(m => m.roomCode), [r.roomCode])
  assert.equal(memberships[0]?.isAway, true)
  const freshLogin = { token: await issueUserAuthToken(u.user.id) }
  const returned = await resume(r, freshLogin.token)
  assert.equal(returned.playerId, a.playerId)
  assert.equal(returned.state.players.find(p => p.id === a.playerId)?.stack, 5000)
  await request(`/api/rooms/${r.roomCode}/state`, undefined, a.playerSessionToken, 403)
  await request(`/api/rooms/${r.roomCode}/leave`, { authToken: freshLogin.token })
  await resume(r, freshLogin.token, 403)
  assert.deepEqual(await request('/api/auth/rooms', { token: u.token }), [])
  const joinedAgain = await join(r, 'A', { authToken: u.token, password: 'reserved-secret' })
  assert.notEqual(joinedAgain.playerId, a.playerId)
})

test('away rejects pending actions, folds, advances turn and does not revive hand on return', async () => {
  const u = await account(), r = await create({ requireDealerActionApproval: true, allowLateJoin: false })
  const a = await join(r, 'A', { authToken: u.token }), b = await join(r, 'B'), c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  const pending = await action(r, a, 'call')
  const result = (await away(r, u.token)).state
  assert.equal(result.currentSession?.currentPlayerId, b.playerId)
  assert.equal(result.players.find(p => p.id === a.playerId)?.status, 'folded')
  assert.equal(result.pendingActions.length, 0)
  await command(r, 'dealer-action', { pendingActionId: pending.action.id, decision: 'approve' }, 404)
  await action(r, a, 'call', 0, 403)
  await request('/api/auth/daily-bonus', { token: u.token }, undefined, 410)
  await command(r, 'force-action', { playerId: a.playerId, type: 'call', amount: 0, clientRequestId: randomUUID() }, 409)
  await command(r, 'undo', {}, 409)
  const returned = await resume(r, u.token)
  assert.equal(returned.state.players.find(p => p.id === a.playerId)?.status, 'folded')
  assert.equal(returned.state.currentSession?.currentPlayerId, b.playerId)
  await action(r, returned, 'call', 0, 409)
  const fold = await action(r, b, 'fold')
  await command(r, 'dealer-action', { pendingActionId: fold.action.id, decision: 'approve' })
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [c.playerId] })
  await command(r, 'start-hand')
  assert.ok(['active', 'checked'].includes((await state(r)).players.find(p => p.id === a.playerId)!.status))
})

test('reserved players miss blinds in later hands and cannot trigger game restart', async () => {
  const u = await account(), r = await create()
  const a = await join(r, 'A', { authToken: u.token }), b = await join(r, 'B'), c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  await away(r, u.token); await action(r, b, 'fold')
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [c.playerId] })
  await command(r, 'start-hand')
  const s = await state(r), seat = s.players.find(p => p.id === a.playerId)!
  assert.equal(seat.isAway, true); assert.equal(seat.stack, 5000); assert.equal(seat.totalCommitted, 0)
  assert.notEqual(s.currentSession?.smallBlindPlayerId, a.playerId)
  assert.notEqual(s.currentSession?.bigBlindPlayerId, a.playerId)
  const returned = await resume(r, u.token)
  assert.equal(returned.state.players.find(p => p.id === a.playerId)?.status, 'out')
  await away(r, u.token)
  const two = await create(), u2 = await account()
  const x = await join(two, 'X', { authToken: u2.token })
  await join(two, 'Y'); await command(two, 'start-game'); await away(two, u2.token)
  await command(two, 'restart-game', {}, 409)
  assert.equal((await state(two)).players.find(p => p.id === x.playerId)?.stack, 5000)
})

test('away all-in keeps eligibility, reserved empty table persists, final exit deletes it', async () => {
  const u = await account(), r = await create()
  await setWalletBalance(u.user.id, 40)
  const a = await join(r, 'A', { authToken: u.token }), b = await join(r, 'B')
  await command(r, 'start-game'); await command(r, 'start-hand')
  await action(r, a, 'all-in'); await away(r, u.token); await action(r, b, 'call')
  assert.equal((await state(r)).players.find(p => p.id === a.playerId)?.status, 'all-in')
  for (const street of ['preflop', 'flop', 'turn']) {
    const s = await state(r)
    await command(r, 'reveal-cards', { handId: s.currentHand!.id, street })
  }
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [a.playerId] })
  const achievementBonus = Number((await db.walletLedgerEntry.aggregate({ where: { wallet: { userId: u.user.id }, entryType: 'ACHIEVEMENT_REWARD' }, _sum: { amount: true } }))._sum.amount || 0n)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).balance - achievementBonus, 0)
  assert.equal((await state(r)).players.find(p => p.id === a.playerId)?.stack, 80)
  await leave(r, b)
  assert.equal((await state(r)).players.filter(p => p.participantId).length, 1)
  await request(`/api/rooms/${r.roomCode}/leave`, { authToken: u.token })
  await request(`/api/rooms/${r.roomCode}/info`, undefined, undefined, 404)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).balance - achievementBonus, 80)
})

test('dealer deletion is authorized, cancels commitments exactly once and disconnects viewers', async () => {
  const u = await account(), r = await create()
  const a = await join(r, 'A', { authToken: u.token }); await join(r, 'B')
  await command(r, 'start-game'); await command(r, 'start-hand'); await action(r, a, 'raise', 50)
  await command(r, 'delete', { dealerSecret: a.playerSessionToken }, 403)
  const socket = new WebSocket(base.replace('http', 'ws') + `/ws/room/${r.roomCode}`)
  const joined = new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token: a.playerSessionToken }))
    socket.onmessage = () => resolve(); socket.onerror = reject
  })
  try {
    await joined
    const closed = new Promise<number>(resolve => { socket.onclose = e => resolve(e.code) })
    const results = await Promise.all([1, 2].map(() => fetch(`${base}/api/rooms/${r.roomCode}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealerSecret: r.dealerSecret }) })))
    assert.deepEqual(results.map(r => r.status).sort(), [200, 404])
    assert.equal(await closed, 4004)
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).balance, 5000)
    await request(`/api/rooms/${r.roomCode}/info`, undefined, undefined, 404)
  } finally { socket.close() }
})

test('cancellation refunds old departed commitments without overwriting a returned account seat', async () => {
  const u = await account(), r = await create()
  const a = await join(r, 'A', { authToken: u.token }); await join(r, 'B'); await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand'); await action(r, a, 'raise', 50)
  await leave(r, a)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).balance, 4950)
  await join(r, 'A', { authToken: u.token })
  await command(r, 'delete')
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.user.id } })).balance, 5000)
})

test('kicked reserved account cannot resume, but may join as a new seat', async () => {
  const u = await account(), r = await create(), a = await join(r, 'A', { authToken: u.token })
  await join(r, 'B'); await away(r, u.token)
  await command(r, 'kick-player', { playerId: a.playerId })
  await resume(r, u.token, 403)
  const b = await join(r, 'A', { authToken: u.token })
  assert.notEqual(b.playerId, a.playerId)
})

test('partial buy-in, elimination, private prediction settlement and profit-only reentry work end to end', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const user = await account()
  const r = await create({
    playerPolicy: 'mixed',
    startingStack: 100,
    buyIn: { enabled: true, minBuyIn: 40, maxBuyIn: 100, allowTopUp: true },
    predictions: {
      enabled: true,
      grantMode: 'original_buy_in',
      minStake: 5,
      maxStake: 40,
      maxStakePercentOfGrant: 100,
      gracePeriodSeconds: 0,
      virtualLiquidityPerMarket: 100,
      treasuryInitialBalance: 1000,
      behaviorImpact: 0.2,
      includeDecisionTime: false,
      comebackMinBuyIn: 1,
      comebackMaxBuyIn: 100,
      maxReentriesPerMember: 1,
      requireDealerApprovalForReentry: true
    },
    roster: { requireDealerApproval: true, lockRosterAfterGameStart: true, allowDealerAccountRebinding: true }
  })

  const a = await join(r, 'ignored', { authToken: user.token, buyInAmount: 40, clientRequestId: randomUUID() })
  const b = await join(r, 'B')
  const c = await join(r, 'C')
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: user.token })).user.balance, 4960)
  assert.equal((await state(r)).players.find(player => player.id === a.playerId)?.stack, 40)

  await command(r, 'start-game')
  await command(r, 'start-hand')
  await action(r, a, 'all-in')
  await action(r, b, 'call')
  await action(r, c, 'fold')
  for (const street of ['preflop', 'flop', 'turn']) {
    const current = await state(r)
    await command(r, 'reveal-cards', { handId: current.currentHand!.id, street })
  }
  await command(r, 'finish-hand')
  await command(r, 'distribute-pot', { winners: [b.playerId] })

  let viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.memberState, 'predicting')
  assert.equal(viewer.balance, 40)
  assert.equal(viewer.grantRemaining, 40)
  assert.equal(viewer.availableProfit, 0)
  assert.equal(viewer.currentMarket, null)

  await command(r, 'start-hand')
  viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.currentMarket?.status, 'open')
  assert.ok(viewer.currentMarket?.quotes.every(quote => [b.playerId, c.playerId].includes(quote.playerId)))
  const current = await state(r)
  const actorId = current.currentSession!.currentPlayerId!
  const winnerId = actorId === b.playerId ? c.playerId : b.playerId
  const requestId = randomUUID()
  const predictionBody = {
    accountToken: user.token,
    memberId: viewer.memberId,
    candidatePlayerId: winnerId,
    stake: 10,
    clientRequestId: requestId,
    expectedMarketRevision: viewer.currentMarket!.revision
  }
  const accepted = await request<{ bet: { id: string }; state: PredictionViewerState }>(`/api/rooms/${r.roomCode}/predictions/${viewer.currentMarket!.id}/bet`, predictionBody)
  const duplicate = await request<{ bet: { id: string }; state: PredictionViewerState }>(`/api/rooms/${r.roomCode}/predictions/${viewer.currentMarket!.id}/bet`, predictionBody)
  assert.equal(duplicate.bet.id, accepted.bet.id)
  assert.equal(duplicate.state.balance, 30)

  const secondBetResponses = await Promise.all([1, 2].map(index => fetch(`${base}/api/rooms/${r.roomCode}/predictions/${viewer.currentMarket!.id}/bet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...predictionBody, clientRequestId: `${randomUUID()}-${index}`, expectedMarketRevision: duplicate.state.currentMarket!.revision })
  })))
  assert.deepEqual(secondBetResponses.map(response => response.status), [409, 409])

  const actor = actorId === b.playerId ? b : c
  await action(r, actor, 'fold')
  await command(r, 'finish-hand')
  await command(r, 'distribute-pot', { winners: [winnerId] })

  viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.currentBet?.status, 'won')
  assert.ok(viewer.balance > viewer.grantRemaining)
  assert.equal(viewer.availableProfit, viewer.balance - 40)
  const dealerView = await request<DealerPredictionState>(`/api/rooms/${r.roomCode}/predictions/dealer`, undefined, r.dealerSecret)
  assert.equal(dealerView.currentMarket?.status, 'settled')
  assert.equal(dealerView.bets.length, 1)

  const reentryAmount = viewer.availableProfit
  const reentry = await request<{ request: { id: string }; state: PredictionViewerState }>(`/api/rooms/${r.roomCode}/reentries/request`, {
    accountToken: user.token,
    memberId: viewer.memberId,
    amount: reentryAmount,
    clientRequestId: randomUUID()
  })
  assert.equal(reentry.state.memberState, 'pending_reentry')
  await request(`/api/rooms/${r.roomCode}/reentries/${reentry.request.id}/decision`, { dealerSecret: r.dealerSecret, decision: 'approve' })
  const afterReentry = await state(r)
  assert.equal(afterReentry.players.find(player => player.id === a.playerId)?.stack, reentryAmount)
  assert.equal((await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)).memberState, 'playing')

  const treasury = await db.roomTreasury.findUniqueOrThrow({ where: { roomId: afterReentry.room.id } })
  const market = await db.predictionMarket.findFirstOrThrow({ where: { roomId: afterReentry.room.id }, orderBy: { createdAt: 'desc' } })
  const bet = await db.predictionBet.findFirstOrThrow({ where: { marketId: market.id } })
  assert.equal(treasury.balance + bet.grossPayout, 1000n + bet.stake)
  await assertRoomTransfersBalanced(r.roomCode)
})

test('a split main pot pays a prediction on either confirmed winner', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const user = await account()
  await setWalletBalance(user.user.id, 40)
  const r = await create({
    startingStack: 100,
    buyIn: { enabled: true, minBuyIn: 40, maxBuyIn: 100, allowTopUp: false },
    predictions: {
      enabled: true,
      grantMode: 'original_buy_in', minStake: 5, maxStake: 40, maxStakePercentOfGrant: 100,
      gracePeriodSeconds: 0, virtualLiquidityPerMarket: 100, treasuryInitialBalance: 1000,
      behaviorImpact: 0.2, includeDecisionTime: false, comebackMinBuyIn: 1, comebackMaxBuyIn: 100,
      maxReentriesPerMember: 1, requireDealerApprovalForReentry: true
    }
  })
  const a = await join(r, 'ignored', { authToken: user.token, buyInAmount: 40, clientRequestId: randomUUID() })
  const b = await join(r, 'B')
  const c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  await action(r, a, 'all-in'); await action(r, b, 'call'); await action(r, c, 'fold')
  for (const street of ['preflop', 'flop', 'turn']) {
    const current = await state(r)
    await command(r, 'reveal-cards', { handId: current.currentHand!.id, street })
  }
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [b.playerId] })

  await command(r, 'start-hand')
  let viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.balance, 40)
  const market = viewer.currentMarket!
  await request(`/api/rooms/${r.roomCode}/predictions/${market.id}/bet`, {
    accountToken: user.token, memberId: viewer.memberId, candidatePlayerId: b.playerId,
    stake: 10, clientRequestId: randomUUID(), expectedMarketRevision: market.revision
  })
  await playToShowdown(r, new Map([[b.playerId, b], [c.playerId, c]]))
  await command(r, 'finish-hand')
  await command(r, 'distribute-pot', { winners: [b.playerId, c.playerId] })

  viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.balance, 230)
  assert.equal(viewer.availableProfit, 220)
  assert.equal(viewer.currentBet?.status, 'won')
  const dealer = await request<DealerPredictionState>(`/api/rooms/${r.roomCode}/predictions/dealer`, undefined, r.dealerSecret)
  assert.equal(dealer.currentMarket?.status, 'settled')
  assert.equal(dealer.currentMarket?.voidReason, undefined)
  await assertRoomTransfersBalanced(r.roomCode)
})

test('only the dealer can manually void an open market and every prediction is refunded once', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const user = await account()
  await setWalletBalance(user.user.id, 40)
  const r = await create({
    startingStack: 100,
    buyIn: { enabled: true, minBuyIn: 40, maxBuyIn: 100, allowTopUp: false },
    predictions: {
      enabled: true,
      grantMode: 'original_buy_in', minStake: 5, maxStake: 40, maxStakePercentOfGrant: 100,
      gracePeriodSeconds: 0, virtualLiquidityPerMarket: 100, treasuryInitialBalance: 1000,
      behaviorImpact: 0.2, includeDecisionTime: false, comebackMinBuyIn: 1, comebackMaxBuyIn: 100,
      maxReentriesPerMember: 1, requireDealerApprovalForReentry: true
    }
  })
  const a = await join(r, 'ignored', { authToken: user.token, buyInAmount: 40, clientRequestId: randomUUID() })
  const b = await join(r, 'B')
  const c = await join(r, 'C')
  await command(r, 'start-game'); await command(r, 'start-hand')
  await action(r, a, 'all-in'); await action(r, b, 'call'); await action(r, c, 'fold')
  for (const street of ['preflop', 'flop', 'turn']) {
    const current = await state(r)
    await command(r, 'reveal-cards', { handId: current.currentHand!.id, street })
  }
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [b.playerId] })
  await command(r, 'start-hand')

  let viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  const market = viewer.currentMarket!
  await request(`/api/rooms/${r.roomCode}/predictions/${market.id}/bet`, {
    accountToken: user.token, memberId: viewer.memberId, candidatePlayerId: b.playerId,
    stake: 10, clientRequestId: randomUUID(), expectedMarketRevision: market.revision
  })
  await request(`/api/rooms/${r.roomCode}/predictions/${market.id}/void`, { dealerSecret: 'wrong-secret', reason: 'test refund' }, undefined, 403)
  await request(`/api/rooms/${r.roomCode}/predictions/${market.id}/void`, { dealerSecret: r.dealerSecret, reason: 'integration refund' })
  await request(`/api/rooms/${r.roomCode}/predictions/${market.id}/void`, { dealerSecret: r.dealerSecret, reason: 'duplicate refund' }, undefined, 409)

  viewer = await request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, user.token)
  assert.equal(viewer.balance, 40)
  assert.equal(viewer.currentBet?.status, 'refunded')
  const dealer = await request<DealerPredictionState>(`/api/rooms/${r.roomCode}/predictions/dealer`, undefined, r.dealerSecret)
  assert.equal(dealer.currentMarket?.status, 'void')
  assert.equal(dealer.currentMarket?.voidReason, 'dealer:integration refund')
  assert.equal(dealer.treasuryBalance, 1000)
  await assertRoomTransfersBalanced(r.roomCode)
})

test('buy-in and top-up retries are idempotent and another account cannot move the stack', async () => {
  const owner = await account()
  const stranger = await account()
  const r = await create({
    buyIn: { enabled: true, minBuyIn: 100, maxBuyIn: 200, allowTopUp: true },
    predictions: { enabled: false }
  })
  const joinKey = randomUUID()
  await join(r, 'ignored', { authToken: owner.token, buyInAmount: 100, clientRequestId: joinKey })
  const seat = await join(r, 'ignored', { authToken: owner.token, buyInAmount: 100, clientRequestId: joinKey })
  let current = await state(r)
  const player = current.players.find(item => item.id === seat.playerId)!
  assert.equal(player.stack, 100)
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: owner.token })).user.balance, 4900)

  const topUpKey = randomUUID()
  const topUpBody = { accountToken: owner.token, memberId: player.memberId, amount: 50, clientRequestId: topUpKey }
  await request(`/api/rooms/${r.roomCode}/top-up`, topUpBody)
  await request(`/api/rooms/${r.roomCode}/top-up`, topUpBody)
  current = await state(r)
  assert.equal(current.players.find(item => item.id === player.id)?.stack, 150)
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: owner.token })).user.balance, 4850)

  await request(`/api/rooms/${r.roomCode}/top-up`, { ...topUpBody, accountToken: stranger.token, clientRequestId: randomUUID() }, undefined, 403)
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: stranger.token })).user.balance, 5000)
})

test('a new account after roster lock waits for dealer approval before wallet debit and seating', async () => {
  const newcomer = await account()
  const r = await create({
    buyIn: { enabled: true, minBuyIn: 40, maxBuyIn: 100, allowTopUp: false },
    predictions: { enabled: false },
    roster: { requireDealerApproval: true, lockRosterAfterGameStart: true, allowDealerAccountRebinding: true }
  })
  await join(r, 'A')
  await join(r, 'B')
  await command(r, 'start-game')

  const pending = await request<{ participantId: string; playerId?: string; memberState: string; playerSessionToken: string }>(`/api/rooms/${r.roomCode}/join`, {
    name: 'ignored', authToken: newcomer.token, buyInAmount: 40, clientRequestId: randomUUID()
  })
  assert.equal(pending.playerId, undefined)
  assert.equal(pending.memberState, 'pending')
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: newcomer.token })).user.balance, 5000)

  const dealerView = await request<DealerPredictionState>(`/api/rooms/${r.roomCode}/predictions/dealer`, undefined, r.dealerSecret)
  const requestMember = dealerView.entryRequests.find(member => member.requestedBuyIn === 40)
  assert.ok(requestMember)
  await request(`/api/rooms/${r.roomCode}/members/${requestMember.id}/decision`, { dealerSecret: r.dealerSecret, decision: 'approve' })
  const admitted = (await state(r)).players.find(player => player.participantId === pending.participantId)
  assert.equal(admitted?.stack, 40)
  assert.equal(admitted?.status, 'waiting')
  assert.equal((await request<{ user: AccountUser }>('/api/auth/me', { token: newcomer.token })).user.balance, 4960)
})

async function fixedMarketFixture(viewerCount = 1, treasury = 1000) {
  const users = []
  for (let i = 0; i < viewerCount; i++) users.push(await account())
  const r = await create({ startingStack: 1000,
    buyIn: { enabled: true, minBuyIn: 40, maxBuyIn: 1000, allowTopUp: false },
    predictions: { enabled: true, minStake: 5, maxStake: 40, maxStakePercentOfGrant: 100,
      gracePeriodSeconds: 60, virtualLiquidityPerMarket: 10, treasuryInitialBalance: treasury,
      behaviorImpact: 0.2, includeDecisionTime: false, comebackMinBuyIn: 1, comebackMaxBuyIn: 100 }
  })
  const viewers: Joined[] = []
  for (const user of users) viewers.push(await join(r, 'ignored', { authToken: user.token, buyInAmount: 40, clientRequestId: randomUUID() }))
  const b = await join(r, 'B'), c = await join(r, 'C')
  const players = new Map([...viewers, b, c].map(player => [player.playerId, player]))
  for (const cmd of ['start-game', 'start-hand']) await command(r, cmd)
  for (let i = 0; i < 16; i++) {
    const s = await state(r)
    if (s.currentHand?.bettingState?.phase !== 'betting') break
    const actor = players.get(s.currentSession!.currentPlayerId!)!
    const p = s.players.find(player => player.id === actor.playerId)!
    await action(r, actor, viewers.includes(actor) ? 'all-in' : p.currentBet < s.currentHand.currentBet ? 'call' : 'check')
  }
  await playToShowdown(r, players)
  await command(r, 'finish-hand'); await command(r, 'distribute-pot', { winners: [b.playerId] }); await command(r, 'start-hand')
  const getViewer = (i = 0) => request<PredictionViewerState>(`/api/rooms/${r.roomCode}/predictions/current`, undefined, users[i]!.token)
  const betBody = (v: PredictionViewerState, i = 0, stake = 10) => ({ accountToken: users[i]!.token, memberId: v.memberId,
    candidatePlayerId: b.playerId, stake, clientRequestId: randomUUID(), expectedMarketRevision: v.currentMarket!.revision })
  const betPath = (v: PredictionViewerState) => `/api/rooms/${r.roomCode}/predictions/${v.currentMarket!.id}/bet`
  const finishRound = async () => {
    for (let step = 0; step < 6; step++) {
      const s = await state(r)
      if (s.currentHand?.bettingState?.phase !== 'betting') return s
      const actor = players.get(s.currentSession!.currentPlayerId!)!
      const p = s.players.find(player => player.id === actor.playerId)!
      await action(r, actor, p.currentBet < s.currentHand.currentBet ? 'call' : 'check')
    }
    assert.fail('Round failed to end')
  }
  return { r, users, b, c, players, getViewer, betBody, betPath, finishRound }
}

test('fixed forecasts span all four streets without holding the game and pay each accepted quote exactly', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture(4)
  const tickets = []
  const observedOdds: number[] = []
  for (const [i, street] of ['preflop', 'flop', 'turn', 'river'].entries()) {
    const v = await f.getViewer(i)
    assert.equal(v.currentMarket?.pricingMode, 'fixed_odds')
    assert.equal(v.currentMarket?.street, street)
    assert.equal(v.currentMarket?.acceptingBets, true)
    assert.equal(v.currentMarket?.lockDueAt, undefined)
    const quote = v.currentMarket!.quotes.find(q => q.playerId === f.b.playerId)!
    observedOdds.push(quote.odds)
    const body = f.betBody(v, i, i === 0 ? 40 : 10)
    const accepted = await request<{ state: PredictionViewerState }>(f.betPath(v), body)
    const ticket = accepted.state.currentBet!
    assert.equal(ticket.acceptedOdds, quote.odds)
    assert.equal(ticket.placedStreet, street)
    assert.equal(ticket.potentialPayout, Math.floor(body.stake * Math.round(quote.odds * 100) / 100))
    tickets.push(ticket)
    // A known idempotency key is not an authorization bypass.
    await request(f.betPath(v), { ...body, accountToken: f.users[(i + 1) % 4]!.token }, undefined, 403)
    const duplicate = await request<{ state: PredictionViewerState }>(f.betPath(v), body)
    assert.equal(duplicate.state.currentBet?.id, ticket.id)
    const end = await f.finishRound()
    if (street !== 'river') {
      assert.equal(end.currentHand?.bettingState?.phase, 'reveal')
      const begin = Date.now()
      await command(f.r, 'reveal-cards', { handId: end.currentHand!.id, street })
      assert.ok(Date.now() - begin < 3000, 'Dealer must not wait for the configured legacy 60-second grace')
    }
  }
  assert.ok(new Set(observedOdds).size > 1)
  const dbMarket = await db.predictionMarket.findUniqueOrThrow({ where: { id: tickets[0]!.marketId } })
  assert.ok(dbMarket.liquidity > 10n, 'First guaranteed payout required and received extra reserve')
  for (let i = 0; i < 4; i++) assert.equal((await f.getViewer(i)).currentBet?.potentialPayout, tickets[i]!.potentialPayout)
  await command(f.r, 'finish-hand'); await command(f.r, 'distribute-pot', { winners: [f.b.playerId] })
  for (let i = 0; i < 4; i++) {
    const v = await f.getViewer(i)
    assert.equal(v.currentBet?.grossPayout, tickets[i]!.potentialPayout)
    assert.equal(v.balance, 40 - tickets[i]!.stake + tickets[i]!.potentialPayout!)
  }
  await command(f.r, 'distribute-pot', { winners: [f.b.playerId] }, 409)
  await assertRoomTransfersBalanced(f.r.roomCode)
})

test('a spectator may wait until river; stale quotes, pause and completed hand reject without debit', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture()
  const initial = await f.getViewer()
  const room = await db.room.findUniqueOrThrow({ where: { code: f.r.roomCode } })
  await db.room.update({ where: { id: room.id }, data: { status: 'paused' } })
  await request(f.betPath(initial), f.betBody(initial), undefined, 409)
  assert.equal((await f.getViewer()).currentMarket?.acceptingBets, false)
  await db.room.update({ where: { id: room.id }, data: { status: 'active' } })
  for (const street of ['preflop', 'flop', 'turn']) {
    const s = await f.finishRound()
    await command(f.r, 'reveal-cards', { handId: s.currentHand!.id, street })
  }
  const river = await f.getViewer()
  assert.equal(river.balance, 40)
  assert.equal(river.currentBet, null)
  assert.equal(river.currentMarket?.acceptingBets, true)
  await request(f.betPath(initial), f.betBody(initial), undefined, 409)
  await f.finishRound()
  await request(f.betPath(river), f.betBody(river), undefined, 409)
  assert.equal((await f.getViewer()).balance, 40)
})

test('insufficient guarantee reserve rejects atomically without charging the spectator', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture(1, 10)
  const v = await f.getViewer()
  await request(f.betPath(v), f.betBody(v, 0, 40), undefined, 409)
  const after = await f.getViewer()
  assert.equal(after.balance, 40)
  assert.equal(after.currentBet, null)
  assert.equal(after.currentMarket?.revision, v.currentMarket?.revision)
  await assertRoomTransfersBalanced(f.r.roomCode)
})

test('fixed tickets survive concurrent retry exactly once, undo voids and refunds the changed-information market', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture()
  const current = await state(f.r)
  const actor = f.players.get(current.currentSession!.currentPlayerId!)!
  await action(f.r, actor, 'call')
  const v = await f.getViewer(), body = f.betBody(v)
  const [one, two] = await Promise.all([
    request<{ state: PredictionViewerState }>(f.betPath(v), body),
    request<{ state: PredictionViewerState }>(f.betPath(v), body)
  ])
  assert.equal(one.state.currentBet?.id, two.state.currentBet?.id)
  assert.equal((await f.getViewer()).balance, 30)
  await command(f.r, 'undo')
  const after = await f.getViewer()
  assert.equal(after.currentMarket?.voidReason, 'poker_action_undone')
  assert.equal(after.currentBet?.status, 'refunded')
  assert.equal(after.balance, 40)
  await assertRoomTransfersBalanced(f.r.roomCode)
})

test('departure of the last opponent atomically closes live forecasts', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture()
  const v = await f.getViewer()
  await command(f.r, 'kick-player', { playerId: f.c.playerId })
  const after = await f.getViewer()
  assert.equal(after.currentMarket?.status, 'locked')
  await request(f.betPath(v), f.betBody(v), undefined, 409)
  assert.equal(after.balance, 40)
})

test('legacy pool tickets retain their settlement contract and no longer delay the flop', { skip: 'Retired monetary placement flow; replacement and legacy settlement covered by overhaul.integration.test.ts' }, async () => {
  const f = await fixedMarketFixture()
  const initial = await f.getViewer()
  await db.predictionMarket.update({ where: { id: initial.currentMarket!.id }, data: { pricingMode: 'pari_mutuel', quoteLiquidity: null, modelVersion: 'public-behavior-v1' } })
  const v = await f.getViewer()
  const accepted = await request<{ state: PredictionViewerState }>(f.betPath(v), f.betBody(v))
  assert.equal(accepted.state.currentBet?.acceptedOdds, null)
  assert.equal(accepted.state.currentBet?.potentialPayout, null)
  const round = await f.finishRound()
  assert.ok((await f.getViewer()).currentMarket?.lockDueAt)
  await command(f.r, 'reveal-cards', { handId: round.currentHand!.id, street: 'preflop' })
  assert.equal((await f.getViewer()).currentMarket?.status, 'locked')
  await playToShowdown(f.r, f.players)
  await command(f.r, 'finish-hand'); await command(f.r, 'distribute-pot', { winners: [f.b.playerId] })
  assert.equal((await f.getViewer()).currentBet?.status, 'won')
  await assertRoomTransfersBalanced(f.r.roomCode)
})
