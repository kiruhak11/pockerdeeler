import type { OnlineAction, OnlineCard, OnlineFinalizedHand, OnlineHand, OnlineHandPlayer, OnlineRoomState, OnlineTablePlayer } from '~/types/online'

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

export function tablePlayerForViewer(table: OnlineRoomState['pokerTable'], viewerId: string | null | undefined): OnlineTablePlayer | null {
  if (!viewerId) return null
  return table.players.find(player => player.playerId === viewerId) ?? null
}

export function isFinishedHand(hand: OnlineHand | null | undefined): boolean {
  return hand?.street === 'FINISHED'
}

export function isPostHandWaitingState(state: OnlineRoomState): boolean {
  const hand = state.pokerTable.currentHand
  return state.pokerTable.status === 'WAITING' && (!hand || isFinishedHand(hand))
}

export function displayHand(hand: OnlineRoomState['pokerTable']['currentHand']): OnlineHand | null {
  return hand && !isFinishedHand(hand) ? hand : null
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

/** Show finalized gold only for cards belonging to a server-declared winner. */
export function isShowdownWinningCard(hand: OnlineFinalizedHand | null | undefined, id: string, playerId?: string): boolean {
  if (!hand || hand.type !== 'CONTESTED') return false
  return hand.players.some(player =>
    player.winner && (!playerId || player.playerId === playerId) && player.contributingCardIds.includes(id)
  )
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
  const layouts: Record<number, readonly Readonly<{ left: string; top: string }>[]> = {
    1: [{ left: '50%', top: '86%' }],
    2: [{ left: '50%', top: '86%' }, { left: '50%', top: '2%' }],
    3: [{ left: '50%', top: '86%' }, { left: '16%', top: '26%' }, { left: '84%', top: '26%' }],
    4: [{ left: '50%', top: '86%' }, { left: '13%', top: '52%' }, { left: '50%', top: '2%' }, { left: '87%', top: '52%' }],
    5: [{ left: '50%', top: '86%' }, { left: '12%', top: '62%' }, { left: '20%', top: '20%' }, { left: '80%', top: '20%' }, { left: '88%', top: '62%' }],
    6: [{ left: '50%', top: '87%' }, { left: '11%', top: '66%' }, { left: '15%', top: '28%' }, { left: '50%', top: '2%' }, { left: '85%', top: '28%' }, { left: '89%', top: '66%' }]
  }
  const safeCount = Math.max(1, Math.min(6, Math.floor(count)))
  const layout = layouts[safeCount] ?? layouts[6]!
  return layout[Math.max(0, Math.min(index, layout.length - 1))]!
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
