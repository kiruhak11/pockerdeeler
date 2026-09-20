import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { registerUser } from '../server/services/userAccountService'
import { ensureLegalDocuments } from '../server/services/legalService'
import { saveDistributionPermissions } from '../server/services/distributionConsentService'
import { getLeaderboardVisibility, setLeaderboardVisibility } from '../server/services/leaderboardVisibilityService'
import { seasonLeaderboard } from '../server/services/seasonService'

const dbUrl = process.env.DATABASE_URL

test('leaderboard visibility defaults on and does not create distribution consent', { skip: !dbUrl }, async () => {
  const db = new PrismaClient()
  const username = `lb_visibility_${Date.now().toString().slice(-8)}`
  try {
    const registered = await registerUser({ username, password: 'Leaderboard-test-password' })
    const userId = registered.user.id
    assert.equal(await getLeaderboardVisibility(userId), true)
    assert.equal(await db.personalDataDistributionConsent.count({ where: { userId } }), 0)

    assert.equal(await setLeaderboardVisibility(userId, false), false)
    assert.equal(await getLeaderboardVisibility(userId), false)
    assert.equal(await db.personalDataDistributionConsent.count({ where: { userId } }), 0)

    assert.equal(await setLeaderboardVisibility(userId, true), true)
    assert.equal(await getLeaderboardVisibility(userId), true)
  } finally {
    await db.user.deleteMany({ where: { username } })
    await db.$disconnect()
  }
})

test('season leaderboard uses the independent visibility setting', { skip: !dbUrl }, async () => {
  const db = new PrismaClient()
  const username = `season_visibility_${Date.now().toString().slice(-8)}`
  try {
    const registered = await registerUser({ username, password: 'Leaderboard-test-password' })
    const userId = registered.user.id
    await ensureLegalDocuments()
    await saveDistributionPermissions({ userId, categories: ['VIRTUAL_BALANCE'], ip: '127.0.0.1', userAgent: 'leaderboard-visibility-test' })

    await setLeaderboardVisibility(userId, false)
    const hidden = await seasonLeaderboard('balance')
    assert.equal(hidden.entries.some(entry => entry.username === username), false)

    await setLeaderboardVisibility(userId, true)
    const visible = await seasonLeaderboard('balance')
    assert.equal(visible.entries.some(entry => entry.username === username), true)
  } finally {
    await db.user.deleteMany({ where: { username } })
    await db.$disconnect()
  }
})
