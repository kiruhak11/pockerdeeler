import type { Player } from '../types/game'

export type Street = 'preflop' | 'flop' | 'turn' | 'river'
export interface BettingState {
  street: Street
  phase: 'betting' | 'reveal' | 'showdown'
  pending: string[]
  lastFullRaise: number
  actedAtBet: Record<string, number>
}

const streets: Street[] = ['preflop', 'flop', 'turn', 'river']
export const streetNames: Record<Street, string> = { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' }
export const canAct = (p: Player) => p.stack > 0 && (p.status === 'active' || p.status === 'checked')
export const contenders = (players: Player[]) => players.filter(p => ['active', 'checked', 'all-in'].includes(p.status))

export function nextActor(players: Player[], pending: string[], afterId?: string | null): string | null {
  const ordered = [...players].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
  const start = ordered.findIndex(p => p.id === afterId)
  for (let offset = 1; offset <= ordered.length; offset++) {
    const p = ordered[(start + offset) % ordered.length]
    if (p && pending.includes(p.id) && canAct(p)) return p.id
  }
  return null
}

function closeIfReady(state: BettingState, players: Player[], currentBet: number): BettingState {
  state.pending = state.pending.filter(id => players.some(p => p.id === id && canAct(p)))
  if (contenders(players).length <= 1) return { ...state, pending: [], phase: 'showdown' }
  const actors = players.filter(canAct)
  // A sole player with chips only acts if they still owe an all-in opponent chips.
  if (actors.length <= 1 && actors.every(p => p.currentBet >= currentBet)) state.pending = []
  if (!state.pending.length) state.phase = state.street === 'river' ? 'showdown' : 'reveal'
  return state
}

export function startBetting(players: Player[], bigBlind: number, street: Street = 'preflop', currentBet = 0): BettingState {
  return closeIfReady({ street, phase: 'betting', pending: players.filter(canAct).map(p => p.id), lastFullRaise: bigBlind, actedAtBet: {} }, players, currentBet)
}

export function afterAction(previous: BettingState, players: Player[], actorId: string, oldBet: number, newBet: number): BettingState {
  const state: BettingState = { ...previous, pending: [...previous.pending], actedAtBet: { ...previous.actedAtBet } }
  if (newBet > oldBet) {
    if (newBet - oldBet >= state.lastFullRaise) state.lastFullRaise = newBet - oldBet
    // Even an incomplete all-in raise must be answered, but it may not reopen raising.
    state.pending = players.filter(p => canAct(p) && p.id !== actorId && (state.pending.includes(p.id) || p.currentBet < newBet)).map(p => p.id)
  } else state.pending = state.pending.filter(id => id !== actorId)
  state.actedAtBet[actorId] = newBet
  return closeIfReady(state, players, newBet)
}

export function removeFromBetting(previous: BettingState, players: Player[], playerId: string, currentBet: number): BettingState {
  return closeIfReady({ ...previous, pending: previous.pending.filter(id => id !== playerId) }, players, currentBet)
}

export function revealNextStreet(previous: BettingState, players: Player[], bigBlind: number): BettingState {
  if (previous.phase !== 'reveal') throw new Error('Сейчас не нужно открывать карты')
  const next = streets[streets.indexOf(previous.street) + 1]
  if (!next) throw new Error('Все общие карты уже открыты')
  return startBetting(players, bigBlind, next, 0)
}

export function validateRoundAction(state: BettingState, player: Player, type: string, amount: number, currentBet: number) {
  if (state.phase !== 'betting' || !state.pending.includes(player.id)) throw new Error('Ожидаем завершения раунда или открытия карт дилером')
  const target = type === 'all-in' ? player.currentBet + player.stack : amount
  if ((type === 'raise' || type === 'bet' || type === 'all-in') && target > currentBet) {
    const acted = state.actedAtBet[player.id]
    if (acted !== undefined && currentBet - acted < state.lastFullRaise) throw new Error('Короткий ва-банк не открывает повторное повышение: уравняйте или сбросьте')
    if (target - currentBet < state.lastFullRaise && target < player.currentBet + player.stack) throw new Error(`Минимальная ставка до ${currentBet + state.lastFullRaise}`)
  }
}
