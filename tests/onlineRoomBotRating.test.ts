import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { recordFinalizedOnlinePokerHand } from '../server/services/onlinePokerRatingService'
import { seasonLeaderboard } from '../server/services/seasonService'
import { createPokerTable, seatPlayer, startTableHand, applyTableAction, advanceTableStreet, finalizeTableHand } from '../server/utils/pokerTableState'

const dbUrl = process.env.DATABASE_URL
const db = new PrismaClient()
let userIds: string[] = []

before(async () => {
  if (!dbUrl) return
  for (let index = 0; index < 2; index += 1) {
    const id = randomUUID()
    userIds.push(id)
    await db.user.create({ data: { id, username: `rating-test-${id.slice(0, 8)}`, passwordHash: 'disabled-test-account' } })
  }
})

after(async () => {
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } })
  await db.$disconnect()
})

test('finalized ONLINE hand updates the ordinary user rating and stats exactly once', { skip: !dbUrl }, async () => {
  const beforeUsers = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, tableRating: true, tableHandsPlayed: true, tableHandsWon: true } })
  const original = new Map(beforeUsers.map(user => [user.id, user]))
  let table = createPokerTable({ tableId: randomUUID(), smallBlind: 5, bigBlind: 10 })
  table = seatPlayer(table, { playerId: userIds[0]!, seat: 1, stack: 100, ready: true })
  table = seatPlayer(table, { playerId: userIds[1]!, seat: 2, stack: 100, ready: true })
  table = startTableHand(table)
  const hand = table.currentHand!
  const actor = hand.players.find(player => player.seat === hand.currentActor)!
  table = applyTableAction(table, { playerId: actor.playerId, type: 'fold' })
  table = advanceTableStreet(table)
  table = finalizeTableHand(table)
  const room: any = { roomId: randomUUID(), roomCode: 'AB2345', type: 'ONLINE', visibility: 'PUBLIC', ownerId: userIds[0], status: 'WAITING', createdAt: new Date().toISOString(), maxPlayers: 6, pokerTable: table, roomVersion: 1, turnDeadlineAt: null, pendingLeaves: [] }
  const first = await recordFinalizedOnlinePokerHand(room)
  const second = await recordFinalizedOnlinePokerHand(room)
  assert.equal(first, 2)
  assert.equal(second, 0)
  const afterUsers = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, tableRating: true, tableHandsPlayed: true, tableHandsWon: true } })
  assert.ok(afterUsers.every(user => user.tableHandsPlayed === original.get(user.id)!.tableHandsPlayed + 1))
  assert.equal(afterUsers.reduce((sum, user) => sum + user.tableHandsWon, 0), beforeUsers.reduce((sum, user) => sum + user.tableHandsWon, 0) + 1)
  const entries = await db.onlinePokerRatingEvent.count({ where: { handId: hand.handId, userId: { in: userIds } } })
  assert.equal(entries, 2)
  const sharedRatingEvents = await db.tableRatingEvent.count({ where: { handId: null, userId: { in: userIds } } })
  assert.ok(sharedRatingEvents >= 2)
  const season = await seasonLeaderboard('tableRating')
  assert.ok(afterUsers.every(user => season.entries.some(entry => entry.userId === user.id && entry.tableRating === user.tableRating)))
})
