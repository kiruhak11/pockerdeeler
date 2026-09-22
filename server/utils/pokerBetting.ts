import type { BetActionLevel, HandActionType, HandPlayerState, InternalHandState } from './pokerHandState'

export const BETTING_ACTION_TYPES = ['check', 'call', 'bet', 'raise', 'fold', 'all-in'] as const
export type BettingActionType = typeof BETTING_ACTION_TYPES[number]

export type BettingAction = Readonly<{
  playerId: string
  type: BettingActionType
  /** For bet and raise, amount is the player's target street contribution. */
  amount?: number
}>

function playerForId(state: InternalHandState, playerId: string): HandPlayerState {
  const player = state.players.find(candidate => candidate.playerId === playerId)
  if (!player) throw new Error(`Unknown player: ${playerId}`)
  return player
}

function assertActionable(state: InternalHandState, player: HandPlayerState): void {
  if (state.street === 'SHOWDOWN' || state.street === 'FINISHED' || state.bettingRoundComplete || state.currentActor === null) {
    throw new Error('Betting round is complete.')
  }
  if (state.currentActor !== player.seat) throw new Error('It is not this player\'s turn.')
  if (player.status === 'FOLDED' || player.status === 'OUT') throw new Error('This player is no longer in the hand.')
  if (player.status === 'ALL_IN' || player.stack <= 0) throw new Error('This player cannot act while all-in.')
}

function positiveAmount(action: BettingAction): number {
  const amount = action.amount
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${action.type} amount must be a positive integer.`)
  }
  return amount
}

function maxStreetContribution(player: HandPlayerState): number {
  return player.streetContribution + player.stack
}

function withCommittedAmount(player: HandPlayerState, target: number): HandPlayerState {
  const available = maxStreetContribution(player)
  if (!Number.isSafeInteger(target) || target < player.streetContribution || target > available) {
    throw new Error('Action amount exceeds the player stack.')
  }
  const committed = target - player.streetContribution
  const stack = player.stack - committed
  return Object.freeze({
    ...player,
    stack,
    contribution: player.contribution + committed,
    streetContribution: target,
    status: stack === 0 ? 'ALL_IN' : 'ACTIVE'
  })
}

function markActed(acted: readonly string[], playerId: string): string[] {
  return acted.includes(playerId) ? [...acted] : [...acted, playerId]
}

function recordActionLevel(levels: readonly BetActionLevel[], playerId: string, bet: number): BetActionLevel[] {
  return [...levels.filter(level => level.playerId !== playerId), Object.freeze({ playerId, bet })]
}

function hasRaiseRights(state: InternalHandState, playerId: string): boolean {
  const level = state.lastActedAtBet.find(candidate => candidate.playerId === playerId)
  if (!level) return true
  return state.currentBet - level.bet >= state.lastFullRaiseSize
}

function orderedSeats(state: InternalHandState): number[] {
  return state.players.map(player => player.seat).sort((left, right) => left - right)
}

function nextActorSeat(state: InternalHandState, afterSeat: number): number | null {
  const seats = orderedSeats(state)
  const start = seats.indexOf(afterSeat)
  if (start < 0) return null
  for (let offset = 1; offset <= seats.length; offset += 1) {
    const seat = seats[(start + offset) % seats.length]!
    const player = state.players.find(candidate => candidate.seat === seat)
    if (player?.status === 'ACTIVE' && player.stack > 0) return seat
  }
  return null
}

function roundComplete(players: readonly HandPlayerState[], currentBet: number, acted: readonly string[]): boolean {
  const contenders = players.filter(player => player.status !== 'FOLDED' && player.status !== 'OUT')
  if (contenders.length <= 1) return true

  const actors = contenders.filter(player => player.status === 'ACTIVE' && player.stack > 0)
  if (actors.length === 0) return true
  const actedSet = new Set(acted)
  return actors.every(player => actedSet.has(player.playerId) && player.streetContribution === currentBet)
}

function nextState(
  state: InternalHandState,
  player: HandPlayerState,
  currentBet: number,
  lastFullRaiseSize: number,
  actedThisRound: readonly string[],
  changedPlayer: HandPlayerState,
  actionLevel: number,
  actionType: HandActionType
): InternalHandState {
  const actedPlayer = Object.freeze({ ...changedPlayer, lastAction: actionType })
  const players = Object.freeze(state.players.map(candidate => candidate.playerId === player.playerId ? actedPlayer : candidate))
  const bettingRoundComplete = roundComplete(players, currentBet, actedThisRound)
  const stateForTurn = { ...state, players } as InternalHandState
  const currentActor = bettingRoundComplete ? null : nextActorSeat(stateForTurn, player.seat)

  return Object.freeze({
    ...state,
    players,
    pot: state.pot + (changedPlayer.contribution - player.contribution),
    currentBet,
    lastFullRaiseSize,
    actedThisRound: Object.freeze([...actedThisRound]),
    bettingRoundComplete,
    currentActor,
    lastActedAtBet: Object.freeze(recordActionLevel(state.lastActedAtBet, player.playerId, actionLevel))
  })
}

export function getToCall(state: InternalHandState, playerId: string): number {
  const player = playerForId(state, playerId)
  return Math.max(0, state.currentBet - player.streetContribution)
}

export function getMinimumRaiseTo(state: InternalHandState): number {
  return state.currentBet + state.lastFullRaiseSize
}

/** Server-only legal action projection used by trusted bot policy code. */
export function getLegalBettingActions(state: InternalHandState, playerId: string): readonly BettingActionType[] {
  const player = playerForId(state, playerId)
  if (state.bettingRoundComplete || state.currentActor !== player.seat || player.status !== 'ACTIVE' || player.stack <= 0) return Object.freeze([])
  const toCall = getToCall(state, playerId)
  const available = maxStreetContribution(player)
  const actions: BettingActionType[] = ['fold']
  if (toCall === 0) actions.push('check')
  else if (toCall <= player.stack) actions.push('call')
  const raiseRights = hasRaiseRights(state, playerId)
  if (player.stack > 0 && (state.currentBet === 0 || available <= state.currentBet || raiseRights)) actions.push('all-in')
  if (state.currentBet === 0 && available > 0) actions.push('bet')
  if (state.currentBet > 0 && raiseRights && available >= getMinimumRaiseTo(state)) actions.push('raise')
  // An all-in that would be a short raise is legal only as an unavoidable
  // short stack wager; existing engine semantics reject short raises otherwise.
  return Object.freeze(actions)
}

/** Applies one server-validated action and returns a new immutable hand state. */
export function applyBettingAction(state: InternalHandState, action: BettingAction): InternalHandState {
  const player = playerForId(state, action.playerId)
  assertActionable(state, player)
  const toCall = getToCall(state, player.playerId)
  const available = maxStreetContribution(player)

  switch (action.type) {
    case 'check': {
      if (toCall !== 0) throw new Error(`Cannot check; ${toCall} chips are required to call.`)
      return nextState(state, player, state.currentBet, state.lastFullRaiseSize, markActed(state.actedThisRound, player.playerId), player, state.currentBet, action.type)
    }

    case 'call': {
      if (toCall === 0) throw new Error('Cannot call when there is nothing to call; use check.')
      const target = Math.min(state.currentBet, available)
      const changedPlayer = withCommittedAmount(player, target)
      return nextState(state, player, state.currentBet, state.lastFullRaiseSize, markActed(state.actedThisRound, player.playerId), changedPlayer, state.currentBet, action.type)
    }

    case 'bet': {
      if (state.currentBet !== 0) throw new Error('Bet is only available when there is no current bet.')
      const target = positiveAmount(action)
      if (target > available) throw new Error('Bet amount exceeds the player stack.')
      if (target < state.bigBlind && target !== available) {
        throw new Error(`Bet must be at least the big blind (${state.bigBlind}) or the player\'s exact all-in.`)
      }
      const changedPlayer = withCommittedAmount(player, target)
      const fullBet = target >= state.bigBlind
      return nextState(
        state,
        player,
        target,
        fullBet ? target : state.lastFullRaiseSize,
        fullBet ? [player.playerId] : markActed(state.actedThisRound, player.playerId),
        changedPlayer,
        target,
        action.type
      )
    }

    case 'raise': {
      if (state.currentBet === 0) throw new Error('Raise is only available when there is a current bet.')
      const target = positiveAmount(action)
      if (target <= state.currentBet) throw new Error(`Raise must be greater than the current bet (${state.currentBet}).`)
      if (target > available) throw new Error('Raise amount exceeds the player stack.')
      if (!hasRaiseRights(state, player.playerId)) throw new Error('Raise is not reopened for this player.')
      const raiseSize = target - state.currentBet
      if (raiseSize < state.lastFullRaiseSize) {
        throw new Error(`Raise must increase the current bet by at least ${state.lastFullRaiseSize}.`)
      }
      const changedPlayer = withCommittedAmount(player, target)
      return nextState(state, player, target, raiseSize, [player.playerId], changedPlayer, target, action.type)
    }

    case 'fold': {
      const changedPlayer = Object.freeze({ ...player, status: 'FOLDED' as const })
      return nextState(state, player, state.currentBet, state.lastFullRaiseSize, markActed(state.actedThisRound, player.playerId), changedPlayer, state.currentBet, action.type)
    }

    case 'all-in': {
      const target = available
      if (state.currentBet === 0) {
        const fullBet = target >= state.bigBlind
        const changedPlayer = withCommittedAmount(player, target)
        return nextState(
          state,
          player,
          target,
          fullBet ? target : state.lastFullRaiseSize,
          fullBet ? [player.playerId] : markActed(state.actedThisRound, player.playerId),
          changedPlayer,
          target,
          action.type
        )
      }

      if (target <= state.currentBet) {
        const changedPlayer = withCommittedAmount(player, target)
        return nextState(state, player, state.currentBet, state.lastFullRaiseSize, markActed(state.actedThisRound, player.playerId), changedPlayer, state.currentBet, action.type)
      }

      if (!hasRaiseRights(state, player.playerId)) throw new Error('Raise is not reopened for this player.')
      const raiseSize = target - state.currentBet
      if (raiseSize < state.lastFullRaiseSize) {
        const changedPlayer = withCommittedAmount(player, target)
        return nextState(
          state,
          player,
          target,
          state.lastFullRaiseSize,
          markActed(state.actedThisRound, player.playerId),
          changedPlayer,
          target,
          action.type
        )
      }
      const changedPlayer = withCommittedAmount(player, target)
      return nextState(state, player, target, raiseSize, [player.playerId], changedPlayer, target, action.type)
    }

    default:
      throw new Error(`Unknown betting action: ${String(action.type)}`)
  }
}
