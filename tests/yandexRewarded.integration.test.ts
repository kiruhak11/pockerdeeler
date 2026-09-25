import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { prisma } from '../server/db/client'
import { cancelYandexRewardedAttempt, completeYandexRewardedAttempt, getYandexRewardedState, startYandexRewardedAttempt } from '../server/services/yandexRewardedService'
import { createOrResumeYandexGuest, exchangeYandexIdentity, getYandexSession } from '../server/services/yandexIdentityService'
import { issueUserAuthToken } from '../server/services/userAccountService'

assert.match(process.env.DATABASE_URL || '', /127\.0\.0\.1:55440\/pocker_gate(?:\?|$)/, 'Use only the isolated pocker_gate test database')
const secret = 'isolated-yandex-rewarded-integration-secret'
const userIds: string[] = []

function signedIdentity(providerUserId: string) {
  const profile = Buffer.from(JSON.stringify({ uniqueID: providerUserId }))
  return `${createHmac('sha256', secret).update(profile).digest('base64')}.${profile.toString('base64')}`
}

async function yandexGuest() {
  const session = await createOrResumeYandexGuest()
  userIds.push(session.user.id)
  return session
}

async function webAccount() {
  const user = await prisma.user.create({ data: { username: `reward_web_${randomUUID().slice(0, 12)}`, passwordHash: 'unused-test-hash', balance: 5000, accountOrigin: 'WEB' } })
  await prisma.userWallet.create({ data: { userId: user.id, balance: 5000n } })
  userIds.push(user.id)
  const token = await issueUserAuthToken(user.id)
  return { user, token }
}

async function start(token: string) {
  return startYandexRewardedAttempt(token, randomUUID())
}

function status(error: unknown) {
  return (error as { statusCode?: number }).statusCode
}

after(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

test('guest progress persists; concurrent third/fourth completion grants once and keeps the fourth view', async () => {
  const guest = await yandexGuest()
  assert.deepEqual(await getYandexRewardedState(guest.token), { viewsSinceGrant: 0, completedGrants: 0, balance: 5000 })

  const first = await start(guest.token)
  const sameAttempt = await Promise.all([
    completeYandexRewardedAttempt(guest.token, first.attemptId),
    completeYandexRewardedAttempt(guest.token, first.attemptId)
  ])
  assert.deepEqual(sameAttempt.map(result => result.viewsSinceGrant), [1, 1])
  assert.equal((await prisma.userWallet.findUniqueOrThrow({ where: { userId: guest.user.id } })).balance, 5000n)

  const second = await start(guest.token)
  await completeYandexRewardedAttempt(guest.token, second.attemptId)
  const third = await start(guest.token)
  const fourth = await start(guest.token)
  await assert.rejects(start(guest.token), error => status(error) === 409)
  const concurrent = await Promise.all([
    completeYandexRewardedAttempt(guest.token, third.attemptId),
    completeYandexRewardedAttempt(guest.token, fourth.attemptId)
  ])
  assert.equal(concurrent.filter(result => result.grantedAmount === 10_000).length, 1)
  assert.equal((await getYandexRewardedState(guest.token)).viewsSinceGrant, 1)
  assert.equal((await getYandexRewardedState(guest.token)).balance, 15_000)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: guest.user.id }, entryType: 'YANDEX_REWARDED_AD_REWARD' } }), 1)

  const persisted = await getYandexRewardedState(guest.token)
  assert.equal(persisted.viewsSinceGrant, 1)
  assert.equal(persisted.completedGrants, 1)
})

test('duplicate grant callback is idempotent, records one ledger entry, and returns the fixed server grant', async () => {
  const guest = await yandexGuest()
  for (let i = 0; i < 2; i += 1) {
    const attempt = await start(guest.token)
    await completeYandexRewardedAttempt(guest.token, attempt.attemptId)
  }
  const third = await start(guest.token)
  const results = await Promise.all([
    completeYandexRewardedAttempt(guest.token, third.attemptId),
    completeYandexRewardedAttempt(guest.token, third.attemptId)
  ])
  assert.deepEqual(results.map(result => result.grantedAmount), [10_000, 10_000])
  assert.deepEqual(results.map(result => result.viewsSinceGrant), [0, 0])
  assert.equal((await prisma.userWallet.findUniqueOrThrow({ where: { userId: guest.user.id } })).balance, 15_000n)
  assert.equal(await prisma.walletLedgerEntry.count({ where: { wallet: { userId: guest.user.id }, entryType: 'YANDEX_REWARDED_AD_REWARD' } }), 1)
  assert.equal((await prisma.yandexRewardedAdAttempt.findUniqueOrThrow({ where: { id: third.attemptId } })).grantedAmount, 10_000)
})

test('authorized Yandex users qualify while WEB accounts and foreign users are rejected', async () => {
  const guest = await yandexGuest()
  const providerUserId = `rewarded-${randomUUID()}`
  const authorized = await exchangeYandexIdentity({ currentToken: guest.token, signature: signedIdentity(providerUserId), secret })
  assert.equal((await getYandexSession(authorized.token)).authorized, true)
  const attempt = await start(authorized.token)
  assert.equal((await completeYandexRewardedAttempt(authorized.token, attempt.attemptId)).viewsSinceGrant, 1)

  const web = await webAccount()
  await assert.rejects(startYandexRewardedAttempt(web.token, randomUUID()), error => status(error) === 401 || status(error) === 403)
  const owner = await yandexGuest()
  const otherYandex = await yandexGuest()
  const owned = await start(owner.token)
  await assert.rejects(completeYandexRewardedAttempt(otherYandex.token, owned.attemptId), error => status(error) === 404)
})

test('cancelled and expired attempts never increase progress; expired attempts are closed durably', async () => {
  const guest = await yandexGuest()
  const cancelled = await start(guest.token)
  assert.equal((await cancelYandexRewardedAttempt(guest.token, cancelled.attemptId)).viewsSinceGrant, 0)
  await assert.rejects(completeYandexRewardedAttempt(guest.token, cancelled.attemptId), error => status(error) === 409)

  const expired = await start(guest.token)
  await prisma.yandexRewardedAdAttempt.update({ where: { id: expired.attemptId }, data: { expiresAt: new Date(Date.now() - 1000) } })
  await assert.rejects(completeYandexRewardedAttempt(guest.token, expired.attemptId), error => status(error) === 409)
  assert.equal((await prisma.yandexRewardedAdAttempt.findUniqueOrThrow({ where: { id: expired.attemptId } })).status, 'EXPIRED')
  assert.equal((await getYandexRewardedState(guest.token)).viewsSinceGrant, 0)
})
