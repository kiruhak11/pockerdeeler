import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { hashSecret } from '../server/services/authService'

// No DB connection, HTTP, paid providers, or production calls. Exercise the real
// chat service with a transaction double; database constraints need integration QA.
const room = { id: 'room-1', code: 'CHAT', dealerId: 'dealer-1', dealerSecretHash: hashSecret('dealer-secret'), status: 'active', revision: 0 }
const players = [
  { id: 'dealer-1', roomId: room.id, name: 'Dealer', userId: null, role: 'dealer', isConnected: true, sessionTokenHash: hashSecret('dealer-session') },
  { id: 'player-1', roomId: room.id, name: 'Player', userId: null, role: 'player', isConnected: true, sessionTokenHash: hashSecret('player-secret') },
  { id: 'spectator-1', roomId: room.id, name: 'Spectator', userId: null, role: 'spectator', isConnected: true, sessionTokenHash: hashSecret('spectator-secret') }
]
let rows: any[] = []
let revision = 0
let serial = Promise.resolve()
const select = (where: any) => rows.filter(row => Object.entries(where).every(([key, value]: [string, any]) => {
  if (key === 'OR') return value.some((branch: any) => Object.entries(branch).every(([field, condition]: [string, any]) => {
    if (condition instanceof Date) return +row[field] === +condition
    if (typeof condition !== 'object') return row[field] === condition
    return Object.entries(condition).every(([operator, bound]: [string, any]) => operator === 'gt' ? row[field] > bound : row[field] < bound)
  }))
  if (value && typeof value === 'object' && 'gte' in value) return row[key] >= value.gte
  return row[key] === value
}))
const tx = {
  $queryRaw: async () => [],
  room: { findUnique: async ({ where }: any) => where.code === room.code ? room : null, update: async () => { revision++; return room } },
  roomParticipant: {
    findUnique: async ({ where }: any) => players.find(player => player.id === where.id) || null,
    findFirst: async ({ where }: any) => players.find(player => Object.entries(where).every(([key, value]) => player[key as keyof typeof player] === value)) || null
  },
  roomChatMessage: {
    findUnique: async ({ where }: any) => select(where.roomId_participantId_clientRequestId)[0] || null,
    findFirst: async ({ where }: any) => select(where)[0] || null,
    findMany: async ({ where, orderBy, take }: any) => {
      const order = Array.isArray(orderBy) ? orderBy : [orderBy]
      return select(where).sort((a, b) => {
        for (const clause of order) {
          const [key, direction] = Object.entries(clause)[0]!
          const value = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
          if (value) return direction === 'desc' ? -value : value
        }
        return 0
      }).slice(0, take)
    },
    create: async ({ data }: any) => {
      const result = { id: `message-${rows.length}`, createdAt: new Date(), deletedAt: null, ...data,
        participant: { role: players.find(player => player.id === data.participantId)!.role } }
      rows.push(result)
      return result
    }
  }
}
;(globalThis as any).prisma = { $transaction: (callback: any) => {
  const result = serial.then(() => callback(tx))
  serial = result.catch(() => {})
  return result
} }
const { sendRoomChatMessage: send, listRoomChatMessages: list } = await import('../server/services/socialService')
const input = { roomCode: room.code, participantId: 'player-1', token: 'player-secret', message: 'Hello', clientRequestId: 'test-request-000001' }
const error = (code: number) => (value: any) => value.statusCode === code
beforeEach(() => { rows = []; revision = 0; room.status = 'active'; players.forEach(player => { player.isConnected = true }) })

test('lost replies and concurrent deliveries return one persisted message and one revision', async () => {
  const results = await Promise.all([send(input), send(input), send(input)])
  assert.equal(rows.length, 1)
  assert.equal(revision, 1)
  assert.equal(new Set(results.map(result => result.message.id)).size, 1)
  assert.deepEqual(results.map(result => result.duplicate), [false, true, true])
})
test('same key cannot change text and normalized retries stay idempotent', async () => {
  await send({ ...input, message: '  Hello\n world  ' })
  const result = await send({ ...input, message: 'Hello world' })
  assert.equal(result.message.text, 'Hello world')
  await assert.rejects(send({ ...input, message: 'Changed' }), error(409))
})
test('blank, oversized, control text and invalid keys fail before persistence', async () => {
  for (const message of [' \n\t\u200B ', 'a'.repeat(301), 'bad\u0000text']) await assert.rejects(send({ ...input, message }), error(400))
  await assert.rejects(send({ ...input, clientRequestId: 'short' }), error(400))
  assert.equal(rows.length, 0)
})
test('HTML stays plain data, never transformed into executable markup by service', async () => {
  const text = '<img src=x onerror=alert(1)><script>alert(1)</script>'
  assert.equal((await send({ ...input, message: text })).message.text, text)
})
test('history rejects strangers, wrong room and revoked membership', async () => {
  await assert.rejects(list({ roomCode: room.code }), error(403))
  await assert.rejects(list({ roomCode: room.code, token: 'wrong-secret' }), error(403))
  await assert.rejects(send({ ...input, participantId: 'spectator-1' }), error(403))
  players[1]!.isConnected = false
  await assert.rejects(list({ roomCode: room.code, token: input.token }), error(403))
  await assert.rejects(send(input), error(403))
})
test('dealer and spectator may read and send, with role derived from participant', async () => {
  assert.equal((await send({ ...input, dealerSecret: 'dealer-secret' })).message.senderRole, 'dealer')
  assert.equal((await send({ ...input, token: 'spectator-secret', participantId: 'spectator-1' })).message.senderRole, 'spectator')
  assert.equal((await list({ roomCode: room.code, token: 'spectator-secret' })).messages.length, 2)
})
test('flood limits new sends but permit a lost-reply retry', async () => {
  await send(input)
  await assert.rejects(send({ ...input, clientRequestId: 'test-request-000002' }), error(429))
  assert.equal((await send(input)).duplicate, true)
  assert.equal(rows.length, 1)
})
test('deleted retries do not reveal text or recreate a moderated message', async () => {
  await send(input)
  rows[0].deletedAt = new Date()
  const result = await send(input)
  assert.equal(result.message.text, '')
  assert.ok(result.message.deletedAt)
  assert.equal((await list({ roomCode: room.code, token: input.token })).messages.length, 0)
  assert.equal(rows.length, 1)
})
test('pagination is bounded, handles timestamp ties, deleted cursors and room isolation', async () => {
  const timestamp = new Date('2026-01-01T00:00:00Z')
  rows = ['a', 'b', 'c', 'd'].map(id => ({ id, roomId: room.id, participantId: 'player-1', text: id, senderName: 'Player', createdAt: timestamp, deletedAt: id === 'c' ? timestamp : null }))
  rows.push({ ...rows[0], id: 'foreign', roomId: 'another-room' })
  const latest = await list({ roomCode: room.code, token: input.token, limit: 2 })
  assert.deepEqual(latest.messages.map(message => message.id), ['b', 'd'])
  assert.equal(latest.nextCursor, 'b')
  assert.deepEqual((await list({ roomCode: room.code, token: input.token, before: 'b', limit: 2 })).messages.map(message => message.id), ['a'])
  assert.deepEqual((await list({ roomCode: room.code, token: input.token, after: 'c', limit: 2 })).messages.map(message => message.id), ['d'])
  await assert.rejects(list({ roomCode: room.code, token: input.token, before: 'foreign' }), error(400))
  await assert.rejects(list({ roomCode: room.code, token: input.token, limit: 10000 }), error(400))
})
