import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { prisma } from '../server/db/client'
import {
  consumeWebSocketAuthTicket,
  createOrResumeYandexGuest,
  exchangeYandexIdentity,
  getYandexSession,
  issueWebSocketAuthTicket
} from '../server/services/yandexIdentityService'
import { verifyUserAuthToken } from '../server/services/userAccountService'

const databaseUrl = process.env.DATABASE_URL || ''
assert.match(databaseUrl, /127\.0\.0\.1:55440\/pocker_gate(?:\?|$)/, 'Use only the isolated pocker_gate test database')
const secret = 'isolated-yandex-integration-secret'
const identities: string[] = []
const users: string[] = []
function signature(providerUserId: string): string {
  const payload = Buffer.from(JSON.stringify({ uniqueID: providerUserId }))
  return `${createHmac('sha256', secret).update(payload).digest('base64')}.${payload.toString('base64')}`
}

after(async () => {
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

test('guest persistence, race-safe Yandex binding, account switch, and one-time WS tickets', async () => {
  const providerUserId = `integration-yandex-${randomUUID()}`
  identities.push(providerUserId)

  const guest = await createOrResumeYandexGuest()
  users.push(guest.user.id)
  const resumed = await createOrResumeYandexGuest(guest.token)
  assert.equal(resumed.user.id, guest.user.id)
  assert.equal(resumed.token, guest.token)
  assert.equal(guest.user.balance, 5000)
  assert.equal(guest.user.phone, null)
  assert.equal(guest.user.predictionRating, 1000)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: guest.user.id }, entryType: 'ACCOUNT_OPENING_GRANT' } }), 1)

  const raced = await Promise.allSettled([
    exchangeYandexIdentity({ currentToken: guest.token, signature: signature(providerUserId), secret }),
    exchangeYandexIdentity({ currentToken: guest.token, signature: signature(providerUserId), secret })
  ])
  const winner = raced.find(result => result.status === 'fulfilled')
  assert.ok(winner && winner.status === 'fulfilled')
  assert.equal(winner.value.user.id, guest.user.id)
  assert.equal(await prisma.externalIdentity.count({ where: { provider: 'YANDEX_GAMES', providerUserId } }), 1)
  assert.equal(await prisma.user.count({ where: { accountOrigin: 'YANDEX_GAMES', externalIdentities: { some: { provider: 'YANDEX_GAMES', providerUserId } } } }), 1)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: guest.user.id }, entryType: 'ACCOUNT_OPENING_GRANT' } }), 1)

  const otherGuest = await createOrResumeYandexGuest()
  users.push(otherGuest.user.id)
  const switched = await exchangeYandexIdentity({ currentToken: otherGuest.token, signature: signature(providerUserId), secret })
  assert.equal(switched.user.id, guest.user.id)
  assert.equal(switched.linkedCurrentGuest, false)
  assert.equal(await verifyUserAuthToken(otherGuest.token), null)
  assert.equal((await prisma.userWallet.findUniqueOrThrow({ where: { userId: guest.user.id } })).balance, 5000n)
  assert.equal((await prisma.userWallet.findUniqueOrThrow({ where: { userId: otherGuest.user.id } })).balance, 5000n)

  const authorized = await getYandexSession(switched.token)
  assert.equal(authorized.authorized, true)
  const ticket = await issueWebSocketAuthTicket(switched.token)
  assert.deepEqual(await consumeWebSocketAuthTicket(ticket), { userId: guest.user.id })
  assert.equal(await consumeWebSocketAuthTicket(ticket), null)
})
