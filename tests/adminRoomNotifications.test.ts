import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { createRoom } from '../server/services/roomService'
import { deleteRoomByDealer } from '../server/services/gameService'

test('room create/close notifications go to admins only', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const suffix = Date.now()
  const admin = await db.user.create({ data: { username: `room_admin_${suffix}`, passwordHash: 'test', role: 'SUPERADMIN' } })
  const ordinary = await db.user.create({ data: { username: `room_user_${suffix}`, passwordHash: 'test' } })
  await db.telegramSubscription.create({ data: { userId: admin.id, chatId: `admin-${suffix}`, telegramUserId: `admin-${suffix}` } })
  await db.telegramSubscription.create({ data: { userId: ordinary.id, chatId: `user-${suffix}`, telegramUserId: `user-${suffix}` } })
  const previousToken = process.env.TELEGRAM_BOT_TOKEN
  const previousFetch = globalThis.fetch
  const messages: { chat_id?: string | number; text?: string }[] = []
  process.env.TELEGRAM_BOT_TOKEN = 'test-room-token'
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string }
    messages.push(body)
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let room: { roomCode: string; dealerSecret: string } | undefined
  try {
    room = await createRoom({ name: `Test room ${suffix}`, startingStack: 1000, maxPlayers: 8, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true }, 'http://test')
    await new Promise(resolve => setTimeout(resolve, 50))
    await deleteRoomByDealer({ roomCode: room.roomCode, dealerSecret: room.dealerSecret })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(messages.length, 2)
    assert.ok(messages.every(message => message.chat_id === `admin-${suffix}`))
    assert.match(messages[0].text || '', /Создана игровая комната/)
    assert.match(messages[1].text || '', /Закрыта игровая комната/)
  } finally {
    if (room) await db.room.deleteMany({ where: { code: room.roomCode } })
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken
    globalThis.fetch = previousFetch
    await db.user.deleteMany({ where: { id: { in: [admin.id, ordinary.id] } } })
    await db.$disconnect()
  }
})
