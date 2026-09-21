import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { registerUser } from '../server/services/userAccountService'
import { transferToFriend } from '../server/services/socialService'

const isolated = Boolean(process.env.DATABASE_URL?.includes(':55439/') || process.env.DATABASE_URL?.includes('_test'))
const db = new PrismaClient()
const userIds: string[] = []

async function account(prefix: string) {
  const result = await registerUser({ username: `${prefix.slice(0, 16)}_${randomUUID().slice(0, 12)}`, password: 'Transfer-test-password-2026' })
  userIds.push(result.user.id)
  return result
}

async function connectFriends(firstId: string, secondId: string) {
  await db.friendship.create({
    data: firstId < secondId
      ? { userAId: firstId, userBId: secondId }
      : { userAId: secondId, userBId: firstId }
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(predicate(), true, 'notification did not finish in time')
}

function errorStatus(error: unknown) {
  return (error as { statusCode?: number }).statusCode
}

after(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds } } })
  await db.$disconnect()
})

test('initial transfer and exact retry move money once and notify once', { skip: !isolated }, async () => {
  const sender = await account('transfer_sender')
  const recipient = await account('transfer_recipient')
  await connectFriends(sender.user.id, recipient.user.id)
  await db.telegramSubscription.create({ data: { userId: recipient.user.id, chatId: `transfer-chat-${randomUUID()}`, telegramUserId: `transfer-tg-${randomUUID()}` } })

  const previousToken = process.env.TELEGRAM_BOT_TOKEN
  const previousFetch = globalThis.fetch
  let notifications = 0
  process.env.TELEGRAM_BOT_TOKEN = 'transfer-test-token'
  globalThis.fetch = async () => {
    notifications++
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const requestId = randomUUID()
    const first = await transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 125, requestId })
    await waitFor(() => notifications === 1)
    const retry = await transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 125, requestId })
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.deepEqual(retry, first)
    assert.equal(notifications, 1)
    assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: sender.user.id } })).balance, 4_875n)
    assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: recipient.user.id } })).balance, 5_125n)
    assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: { in: [`friend-transfer:debit:${requestId}`, `friend-transfer:credit:${requestId}`] } } }), 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = previousToken
  }
})

test('same requestId with a different amount is a conflict and changes nothing', { skip: !isolated }, async () => {
  const sender = await account('transfer_amount_sender')
  const recipient = await account('transfer_amount_recipient')
  await connectFriends(sender.user.id, recipient.user.id)
  const requestId = randomUUID()

  await transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 200, requestId })
  await assert.rejects(
    () => transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 201, requestId }),
    error => errorStatus(error) === 409
  )
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: sender.user.id } })).balance, 4_800n)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: recipient.user.id } })).balance, 5_200n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: { in: [`friend-transfer:debit:${requestId}`, `friend-transfer:credit:${requestId}`] } } }), 2)
})

test('same requestId with a different recipient is a conflict and creates no second transfer', { skip: !isolated }, async () => {
  const sender = await account('transfer_recipient_sender')
  const firstRecipient = await account('transfer_recipient_first')
  const secondRecipient = await account('transfer_recipient_second')
  await connectFriends(sender.user.id, firstRecipient.user.id)
  await connectFriends(sender.user.id, secondRecipient.user.id)
  const requestId = randomUUID()

  await transferToFriend({ token: sender.token, friendUserId: firstRecipient.user.id, amount: 175, requestId })
  await assert.rejects(
    () => transferToFriend({ token: sender.token, friendUserId: secondRecipient.user.id, amount: 175, requestId }),
    error => errorStatus(error) === 409
  )
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: secondRecipient.user.id } })).balance, 5_000n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: { in: [`friend-transfer:debit:${requestId}`, `friend-transfer:credit:${requestId}`] } } }), 2)
})

test('concurrent identical requests produce one debit and one credit', { skip: !isolated }, async () => {
  const sender = await account('transfer_concurrent_sender')
  const recipient = await account('transfer_concurrent_recipient')
  await connectFriends(sender.user.id, recipient.user.id)
  const requestId = randomUUID()

  const results = await Promise.all([
    transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 333, requestId }),
    transferToFriend({ token: sender.token, friendUserId: recipient.user.id, amount: 333, requestId })
  ])
  assert.deepEqual(results[0], results[1])
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: sender.user.id } })).balance, 4_667n)
  assert.equal((await db.userWallet.findUniqueOrThrow({ where: { userId: recipient.user.id } })).balance, 5_333n)
  assert.equal(await db.walletLedgerEntry.count({ where: { idempotencyKey: { in: [`friend-transfer:debit:${requestId}`, `friend-transfer:credit:${requestId}`] } } }), 2)
})
