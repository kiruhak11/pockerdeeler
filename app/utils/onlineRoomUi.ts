import type { OnlineAction, OnlineCard, OnlineHandPlayer, OnlineRoomState } from '~/types/online'

export type OnlineSocketLocation = Readonly<{
  protocol: string
  host: string
}>

export function onlineSocketUrl(location: OnlineSocketLocation, code: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws/online/${encodeURIComponent(code.trim().toUpperCase())}`
}

export function createOnlineActionId(random: () => string = () => Math.random().toString(36).slice(2)): string {
  const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID()
  return `online-action-${Date.now()}-${random()}`
}

export function actionMessage(actionId: string, stateVersion: number, action: OnlineAction): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    type: 'PLAYER_ACTION',
    actionId,
    expectedTableStateVersion: stateVersion,
    action
  }
}

export function startHandMessage(stateVersion: number): Readonly<Record<string, unknown>> {
  return { version: 1, type: 'START_HAND', expectedTableStateVersion: stateVersion }
}

export function pingMessage(): Readonly<Record<string, unknown>> {
  return { version: 1, type: 'PING' }
}

export function playerForViewer(hand: OnlineRoomState['pokerTable']['currentHand'], viewerId: string | null | undefined): OnlineHandPlayer | null {
  if (!hand || !viewerId) return null
  return hand.players.find(player => player.playerId === viewerId) ?? null
}

export function ownHoleCards(hand: OnlineRoomState['pokerTable']['currentHand'], viewerId: string | null | undefined): readonly OnlineCard[] {
  return playerForViewer(hand, viewerId)?.holeCards ?? []
}

export function isViewerActor(hand: OnlineRoomState['pokerTable']['currentHand'], viewerId: string | null | undefined): boolean {
  const player = playerForViewer(hand, viewerId)
  return Boolean(player && hand && hand.currentActor === player.seat && player.status === 'ACTIVE' && player.stack > 0)
}

export function toCall(hand: OnlineRoomState['pokerTable']['currentHand'], viewerId: string | null | undefined): number {
  const player = playerForViewer(hand, viewerId)
  return player && hand ? Math.max(0, hand.currentBet - player.streetContribution) : 0
}

export function cardLabel(card: OnlineCard): string {
  const suit = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }[card.suit]
  return `${card.rank === 'T' ? '10' : card.rank}${suit}`
}

export function cardIsRed(card: OnlineCard): boolean {
  return card.suit === 'diamonds' || card.suit === 'hearts'
}

export function remainingTurnSeconds(deadline: number | null, now = Date.now()): number | null {
  if (deadline === null || !Number.isFinite(deadline)) return null
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function formatTurnSeconds(seconds: number | null): string {
  if (seconds === null) return ''
  return `00:${String(seconds).padStart(2, '0')}`
}

export function seatPosition(index: number, count: number): Readonly<{ left: string; top: string }> {
  const safeCount = Math.max(1, count)
  const angle = (index / safeCount) * Math.PI * 2
  return {
    left: `${50 + Math.sin(angle) * 43}%`,
    top: `${50 - Math.cos(angle) * 42}%`
  }
}

export function publicStateHasPrivateFields(value: unknown): boolean {
  const forbidden = new Set(['deck', 'burnCards', 'privateJoinSecret', 'privateJoinSecretHash', 'runtimeRevision', 'lockToken', 'jobId'])
  const visited = new WeakSet<object>()
  function scan(candidate: unknown): boolean {
    if (!candidate || typeof candidate !== 'object') return false
    if (visited.has(candidate)) return false
    visited.add(candidate)
    if (Array.isArray(candidate)) return candidate.some(scan)
    const record = candidate as Record<string, unknown>
    return Object.keys(record).some(key => forbidden.has(key) || scan(record[key]))
  }
  return scan(value)
}

export function isSafeRoomState(value: unknown): value is OnlineRoomState {
  if (!value || typeof value !== 'object') return false
  const room = value as Partial<OnlineRoomState>
  return room.type === 'ONLINE' && typeof room.roomCode === 'string' && typeof room.pokerTable === 'object' && !publicStateHasPrivateFields(value)
}
