import test from 'node:test'
import assert from 'node:assert/strict'
import { assertBotProfileMatches } from '../server/services/botIdentityService'

test('stored bot nickname is not part of durable bot identity', () => {
  assert.doesNotThrow(() => assertBotProfileMatches({
    id: 'bot-id', username: 'Бубей Андреенко', isBot: true, botKey: 'online-bot-23',
    botEnabled: true, botSkillTier: 'REGULAR', botPlayStyle: 'TIGHT_PASSIVE', balance: 5_000,
    tableRating: 1_000, tableHandsPlayed: 0, tableHandsWon: 0, predictionRating: 1_000,
    leaderboardVisible: true
  }, {
    botKey: 'online-bot-23', nickname: 'Finn Blake', skillTier: 'REGULAR', playStyle: 'TIGHT_PASSIVE'
  }))
})

test('bot key and strategy metadata remain validated independently of nickname', () => {
  const stored = {
    id: 'bot-id', username: 'Different display name', isBot: true, botKey: 'online-bot-23',
    botEnabled: true, botSkillTier: 'REGULAR', botPlayStyle: 'TIGHT_PASSIVE', balance: 5_000,
    tableRating: 1_000, tableHandsPlayed: 0, tableHandsWon: 0, predictionRating: 1_000,
    leaderboardVisible: true
  }
  assert.throws(() => assertBotProfileMatches({ ...stored, botKey: 'someone-else' }, {
    botKey: 'online-bot-23', nickname: 'Finn Blake', skillTier: 'REGULAR', playStyle: 'TIGHT_PASSIVE'
  }))
})
