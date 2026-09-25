import {
  createAuthenticatedOnlineRoom,
  findActivePublicOnlineRoomForPlayer,
  getAuthenticatedOnlineRoom,
  getOnlinePokerBotDecisionSnapshot,
  joinAuthenticatedOnlineRoom,
  leaveAuthenticatedOnlineRoom,
  listPublicOnlineRooms,
  setAuthenticatedOnlineRoomReady,
  startAuthenticatedOnlineRoomHand,
  applyAuthenticatedOnlineRoomAction,
  countPublicOnlineRoomsOwnedByBots,
  closeEmptyPublicOnlineRoomsCreatedByBots,
  markBotOnlyOnlineRoomDraining,
  type OnlinePokerBotDecisionSnapshot
} from './onlineRoomApiService'
import { ensureOnlinePokerBots, listOnlinePokerBots, replenishOnlinePokerBotDailyBalances } from './botIdentityService'
import { getBotRocketSnapshot, placeCrashBetForBot, registerBotRocketLease } from './crashService'
import type { BotActionDecisionSnapshot, OnlinePokerBotOrchestratorAdapter } from './onlinePokerBotOrchestrator'
import type { OnlineRoomApiDependencies } from './onlineRoomApiService'

/** Production adapter: bots use the same account-backed ONLINE API and mutations as humans. */
export const onlinePokerBotApiAdapter: OnlinePokerBotOrchestratorAdapter = Object.freeze({
  listBots: listOnlinePokerBots,
  replenishDailyBalances: replenishOnlinePokerBotDailyBalances,
  listPublicRooms: listPublicOnlineRooms,
  countBotCreatedRooms: countPublicOnlineRoomsOwnedByBots,
  cleanupBotCreatedRooms: closeEmptyPublicOnlineRoomsCreatedByBots,
  markRoomDraining: markBotOnlyOnlineRoomDraining,
  findSeatedRoom: findActivePublicOnlineRoomForPlayer,
  getRoom: getAuthenticatedOnlineRoom,
  getDecisionSnapshot: async (userId, code, dependencies): Promise<BotActionDecisionSnapshot> => {
    const snapshot: OnlinePokerBotDecisionSnapshot = await getOnlinePokerBotDecisionSnapshot(userId, code, dependencies)
    return snapshot
  },
  createRoom: createAuthenticatedOnlineRoom,
  joinRoom: (userId, code, dependencies) => joinAuthenticatedOnlineRoom(userId, code, {}, dependencies),
  ready: async (userId, code, ready, _room, dependencies) => {
    const current = await getAuthenticatedOnlineRoom(userId, code, dependencies)
    return setAuthenticatedOnlineRoomReady(userId, code, {
      ready,
      concurrencyToken: current.concurrencyToken,
      expectedRoomVersion: current.room.roomVersion
    }, dependencies)
  },
  startHand: startAuthenticatedOnlineRoomHand,
  action: applyAuthenticatedOnlineRoomAction,
  leave: async (userId, code, _room, dependencies) => {
    const current = await getAuthenticatedOnlineRoom(userId, code, dependencies)
    return leaveAuthenticatedOnlineRoom(userId, code, {
      concurrencyToken: current.concurrencyToken,
      expectedRoomVersion: current.room.roomVersion
    }, dependencies)
  },
  registerRocketLease: registerBotRocketLease,
  getRocketSnapshot: getBotRocketSnapshot,
  placeRocketBet: placeCrashBetForBot
})

export { ensureOnlinePokerBots }

/** Merges integration-test infrastructure while preserving server-issued fence data. */
export function withOnlinePokerBotApiDependencies(
  fenced: OnlineRoomApiDependencies,
  infrastructure: Pick<OnlineRoomApiDependencies, 'runtime' | 'timer'>
): OnlineRoomApiDependencies {
  return Object.freeze({ ...infrastructure, ...fenced })
}
