import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { createRoom } from '../server/services/roomService'
import { deleteRoomByDealer } from '../server/services/gameService'
import { awaitPendingAdminTelegramNotifications } from '../server/services/adminTelegramNotificationService'

test('room create/close notifications go to admins only', { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient()
  const suffix = Date.now()
  const admin = await db.user.create({ data: { username: `room_admin_${suffix}`, passwordHash: 'test', role: 'SUPERADMIN' } })
  const ordinary = await db.user.create({ data: { username: `room_user_${suffix}`, passwordHash: 'test' } })
  await db.telegramSubscription.create({ data: { userId: admin.id, chatId: `admin-${suffix}`, telegramUserId: `admin-${suffix}` } })
  await db.telegramSubscription.create({ data: { userId: ordinary.id, chatId: `user-${suffix}`, telegramUserId: `user-${suffix}` } })
  const previousToken = process.env.TELEGRAM_BOT_TOKEN
  const previousFetch = globalThis.fetch
  let messages: { chat_id?: string | number; text?: string }[] = []
  process.env.TELEGRAM_BOT_TOKEN = 'test-room-token'
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string }
    messages.push(body)
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let room: { roomCode: string; dealerSecret: string } | undefined
  try {
    let releaseTransport!: () => void
    let resolveTwoSends!: () => void
    let startedSends = 0
    const transportGate = new Promise<void>(resolve => { releaseTransport = resolve })
    const twoSendsStarted = new Promise<void>(resolve => { resolveTwoSends = resolve })
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string }
      messages.push(body)
      startedSends += 1
      if (startedSends >= 2) resolveTwoSends()
      await transportGate
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    room = await createRoom({ name: `Test room ${suffix}`, startingStack: 1000, maxPlayers: 8, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true }, 'http://test')
    await deleteRoomByDealer({ roomCode: room.roomCode, dealerSecret: room.dealerSecret })
    await twoSendsStarted
    releaseTransport()
    await awaitPendingAdminTelegramNotifications()

    const roomMessages = messages.filter(message => message.text?.includes(`(${room!.roomCode})`))
    const testAdminMessages = roomMessages.filter(message => message.chat_id === `admin-${suffix}`)
    assert.equal(testAdminMessages.length, 2)
    assert.equal(roomMessages.filter(message => message.chat_id === `user-${suffix}`).length, 0)
    assert.equal(testAdminMessages.filter(message => /Создана игровая комната/.test(message.text || '')).length, 1)
    assert.equal(testAdminMessages.filter(message => /Закрыта игровая комната/.test(message.text || '')).length, 1)

    await assert.rejects(deleteRoomByDealer({ roomCode: room.roomCode, dealerSecret: room.dealerSecret }))
    await awaitPendingAdminTelegramNotifications()
    assert.equal(messages.filter(message => message.text?.includes(`(${room!.roomCode})`) && /Закрыта игровая комната/.test(message.text || '')).length, 1)

    messages = []
    const previousError = console.error
    const failedAttempts: { chat_id?: string | number; text?: string }[] = []
    console.error = () => undefined
    globalThis.fetch = async (_input, init) => {
      failedAttempts.push(JSON.parse(String(init?.body || '{}')) as { chat_id?: string | number; text?: string })
      throw new Error('Telegram unavailable')
    }
    try {
      const failedTransportRoom = await createRoom({ name: `Transport failure ${suffix}`, startingStack: 1000, maxPlayers: 8, allowLateJoin: true, requireDealerActionApproval: false, allowSpectators: true }, 'http://test')
      assert.ok(await db.room.findUnique({ where: { code: failedTransportRoom.roomCode } }))
      await awaitPendingAdminTelegramNotifications()
      await deleteRoomByDealer({ roomCode: failedTransportRoom.roomCode, dealerSecret: failedTransportRoom.dealerSecret })
      await awaitPendingAdminTelegramNotifications()
      await assert.rejects(deleteRoomByDealer({ roomCode: failedTransportRoom.roomCode, dealerSecret: failedTransportRoom.dealerSecret }))
      const targetAdminAttempts = failedAttempts.filter(message => message.chat_id === `admin-${suffix}`)
      assert.equal(targetAdminAttempts.length, 2)
      assert.equal(targetAdminAttempts.filter(message => /Создана игровая комната/.test(message.text || '')).length, 1)
      assert.equal(targetAdminAttempts.filter(message => /Закрыта игровая комната/.test(message.text || '')).length, 1)
    } finally {
      console.error = previousError
    }
  } finally {
    if (room) await db.room.deleteMany({ where: { code: room.roomCode } })
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken
    globalThis.fetch = previousFetch
    await db.user.deleteMany({ where: { id: { in: [admin.id, ordinary.id] } } })
    await db.$disconnect()
  }
})
