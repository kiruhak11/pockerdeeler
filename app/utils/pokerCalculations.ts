import type {
  ActionInput,
  ActionResult,
  AvailableActions,
  Player,
  PlayerAction,
  PotDistributionResult,
  SidePot,
  WinnerResult
} from '~/types/game'

const FOLDED_OR_OUT = new Set(['folded', 'out'])

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeAmount(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0
  }

  return Math.trunc(value)
}

export function clonePlayers(players: Player[]): Player[] {
  return players.map((player) => ({ ...player }))
}

export function resetPlayersForNewHand(players: Player[]): Player[] {
  return players.map((player) => {
    const isOut = player.stack <= 0
    return {
      ...player,
      stack: Math.max(0, Math.trunc(player.stack)),
      currentBet: 0,
      totalCommitted: 0,
      status: isOut ? 'out' : 'active'
    }
  })
}

export function sumCommitted(players: Player[]): number {
  return players.reduce((sum, player) => sum + player.totalCommitted, 0)
}

function applyContribution(player: Player, requestedAmount: number): number {
  const amount = Math.max(0, Math.min(player.stack, requestedAmount))
  if (amount <= 0) {
    return 0
  }

  player.stack -= amount
  player.currentBet += amount
  player.totalCommitted += amount
  return amount
}

function validateActionAvailability(player: Player, action: ActionInput): void {
  if (action.type === 'fold') {
    if (player.status === 'folded' || player.status === 'out') {
      throw new Error('Этот игрок уже не участвует в раздаче.')
    }
    return
  }

  if (player.status === 'folded' || player.status === 'out') {
    throw new Error('Игрок не может сделать действие в текущей раздаче.')
  }

  if (player.stack <= 0 && action.type !== 'check') {
    throw new Error('У игрока нет фишек для действия.')
  }
}

export function applyPlayerAction(
  playersBefore: Player[],
  potBefore: number,
  currentBetBefore: number,
  input: ActionInput
): ActionResult {
  const players = clonePlayers(playersBefore)
  const player = players.find((item) => item.id === input.playerId)
  if (!player) {
    throw new Error('Игрок не найден.')
  }

  validateActionAvailability(player, input)

  let pot = potBefore
  let currentBet = currentBetBefore
  let actionType = input.type
  let contributed = 0

  if (input.type === 'check') {
    if (player.currentBet !== currentBet) {
      throw new Error('Чек недоступен: нужно уравнять ставку.')
    }

    player.status = 'checked'
  }

  if (input.type === 'fold') {
    player.status = 'folded'
  }

  if (input.type === 'bet') {
    if (currentBet > 0) {
      throw new Error('Ставка недоступна: используйте Рейз.')
    }

    const amount = normalizeAmount(input.amount)
    if (amount <= 0) {
      throw new Error('Сумма ставки должна быть больше 0.')
    }
    if (amount > player.stack) {
      throw new Error('Нельзя поставить больше стека. Используйте Ва-банк.')
    }

    contributed = applyContribution(player, amount)
    currentBet = Math.max(currentBet, player.currentBet)
    player.status = player.stack === 0 ? 'all-in' : 'active'
  }

  if (input.type === 'call') {
    if (currentBet <= player.currentBet) {
      throw new Error('Колл недоступен: у игрока уже уравненная ставка.')
    }

    const toCall = currentBet - player.currentBet
    contributed = applyContribution(player, toCall)
    if (contributed <= 0) {
      throw new Error('Недостаточно фишек для действия.')
    }

    if (contributed < toCall) {
      actionType = 'all-in'
    }

    player.status = player.stack === 0 ? 'all-in' : 'active'
  }

  if (input.type === 'raise') {
    const targetBet = normalizeAmount(input.amount)
    if (targetBet <= currentBet) {
      throw new Error('Рейз должен быть больше текущей максимальной ставки.')
    }

    const toPut = targetBet - player.currentBet
    if (toPut <= 0) {
      throw new Error('Некорректная сумма для Raise.')
    }

    if (toPut > player.stack) {
      contributed = applyContribution(player, player.stack)
      actionType = 'all-in'
    } else {
      contributed = applyContribution(player, toPut)
    }

    if (contributed <= 0) {
      throw new Error('Недостаточно фишек для действия.')
    }

    currentBet = Math.max(currentBet, player.currentBet)
    player.status = player.stack === 0 ? 'all-in' : 'active'
  }

  if (input.type === 'all-in') {
    if (player.stack <= 0) {
      throw new Error('У игрока нет фишек для действия Ва-банк.')
    }

    contributed = applyContribution(player, player.stack)
    currentBet = Math.max(currentBet, player.currentBet)
    player.status = 'all-in'
  }

  pot += contributed

  const action: PlayerAction = {
    id: uid('action'),
    playerId: input.playerId,
    type: actionType,
    amount: contributed,
    timestamp: Date.now()
  }

  return {
    players,
    pot,
    currentBet,
    action
  }
}

function sortBySeatThenId(ids: string[], playersById: Map<string, Player>): string[] {
  return [...ids].sort((a, b) => {
    const first = playersById.get(a)
    const second = playersById.get(b)

    const firstSeat = first?.seat ?? Number.MAX_SAFE_INTEGER
    const secondSeat = second?.seat ?? Number.MAX_SAFE_INTEGER

    if (firstSeat !== secondSeat) {
      return firstSeat - secondSeat
    }

    return a.localeCompare(b)
  })
}

function splitEvenly(total: number, winnerIds: string[], playersById: Map<string, Player>): WinnerResult[] {
  if (winnerIds.length === 0 || total <= 0) {
    return []
  }

  const ordered = sortBySeatThenId(winnerIds, playersById)
  const base = Math.floor(total / ordered.length)
  const remainder = total % ordered.length

  return ordered.map((playerId, index) => ({
    playerId,
    amountWon: base + (index < remainder ? 1 : 0)
  }))
}

/**
 * Builds main pot + side pots from final contributions.
 * Each layer is the difference between commitment levels.
 *
 * Example of caps [40, 100]:
 * - Layer 0..40 contributes from all players with committed >= 40 (main pot)
 * - Layer 40..100 contributes only from players with committed >= 100 (side pot)
 */
export function calculatePots(players: Player[]): SidePot[] {
  const committedPlayers = players.filter((player) => player.totalCommitted > 0)
  if (!committedPlayers.length) {
    return []
  }

  const levels = [...new Set(committedPlayers.map((player) => player.totalCommitted))].sort((a, b) => a - b)
  const pots: SidePot[] = []
  let previousLevel = 0

  for (const cap of levels) {
    const contributors = committedPlayers.filter((player) => player.totalCommitted >= cap)
    const layerSize = cap - previousLevel
    if (layerSize <= 0 || contributors.length === 0) {
      continue
    }

    const amount = layerSize * contributors.length
    const eligiblePlayerIds = contributors
      .filter((player) => !FOLDED_OR_OUT.has(player.status))
      .map((player) => player.id)

    pots.push({
      id: pots.length + 1,
      amount,
      cap,
      eligiblePlayerIds
    })

    previousLevel = cap
  }

  return pots
}

function mergeResults(items: WinnerResult[]): WinnerResult[] {
  const map = new Map<string, number>()
  for (const item of items) {
    map.set(item.playerId, (map.get(item.playerId) ?? 0) + item.amountWon)
  }

  return [...map.entries()].map(([playerId, amountWon]) => ({ playerId, amountWon }))
}

export function distributePot(
  playersBefore: Player[],
  selectedWinnerIds: string[]
): { players: Player[]; result: PotDistributionResult } {
  const players = clonePlayers(playersBefore)
  if (!selectedWinnerIds.length) {
    throw new Error('Выберите хотя бы одного победителя.')
  }

  const winnerSet = new Set(selectedWinnerIds)
  const playersById = new Map(players.map((player) => [player.id, player]))
  const pots = calculatePots(players)

  if (!pots.length) {
    throw new Error('Банк пустой, нечего распределять.')
  }

  const winnerPayouts: WinnerResult[] = []
  const returnedPayouts: WinnerResult[] = []

  for (const pot of pots) {
    const eligibleWinners = pot.eligiblePlayerIds.filter((playerId) => winnerSet.has(playerId))

    if (eligibleWinners.length > 0) {
      winnerPayouts.push(...splitEvenly(pot.amount, eligibleWinners, playersById))
      continue
    }

    // If no selected winner can claim this pot, return it to its last contributors.
    // This protects chips from being lost because of an incorrect manual winner selection.
    const contributors = players.filter((player) => player.totalCommitted >= pot.cap).map((player) => player.id)
    if (contributors.length > 0) {
      returnedPayouts.push(...splitEvenly(pot.amount, contributors, playersById))
    }
  }

  const mergedWinners = mergeResults(winnerPayouts)
  const mergedReturned = mergeResults(returnedPayouts)

  for (const payout of [...mergedWinners, ...mergedReturned]) {
    const player = playersById.get(payout.playerId)
    if (player) {
      player.stack += payout.amountWon
    }
  }

  for (const player of players) {
    player.currentBet = 0
    player.totalCommitted = 0

    if (player.stack <= 0) {
      player.status = 'out'
      continue
    }

    if (mergedWinners.some((winner) => winner.playerId === player.id)) {
      player.status = 'winner'
    } else {
      player.status = 'active'
    }
  }

  return {
    players,
    result: {
      winners: mergedWinners,
      returned: mergedReturned,
      pots
    }
  }
}

export function chipsInvariant(players: Player[], expectedTotal: number): boolean {
  const currentTotal = players.reduce((sum, player) => sum + player.stack + player.totalCommitted, 0)
  return currentTotal === expectedTotal
}

export function calculateCallAmount(player: Player, tableCurrentBet: number): number {
  return Math.max(0, tableCurrentBet - player.currentBet)
}

export function calculateRaiseAmount(player: Player, targetBet: number): number {
  return Math.max(0, targetBet - player.currentBet)
}

export function calculateMainPot(players: Player[]): number {
  return sumCommitted(players)
}

export function calculateSidePots(players: Player[]): SidePot[] {
  return calculatePots(players)
}

export function assertChipConservation(players: Player[], expectedTotal: number): void {
  if (!chipsInvariant(players, expectedTotal)) {
    throw new Error('Нарушен инвариант фишек: сумма фишек изменилась.')
  }
}

export function createGameSnapshot(players: Player[], pot: number, currentBet: number) {
  return {
    players: clonePlayers(players),
    pot,
    currentBet
  }
}

export function restoreGameSnapshot(
  snapshot: ReturnType<typeof createGameSnapshot>
): { players: Player[]; pot: number; currentBet: number } {
  return {
    players: clonePlayers(snapshot.players),
    pot: snapshot.pot,
    currentBet: snapshot.currentBet
  }
}

export function validatePlayerAction(
  players: Player[],
  tableCurrentBet: number,
  action: ActionInput
): { valid: boolean; reason?: string } {
  try {
    applyPlayerAction(players, sumCommitted(players), tableCurrentBet, action)
    return { valid: true }
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Некорректное действие.'
    }
  }
}

export function getAvailableActions(
  player: Player,
  gameState: {
    currentBet: number
    handActive: boolean
    isCurrentPlayer: boolean
  }
): AvailableActions {
  const inactive = player.status === 'folded' || player.status === 'all-in' || player.status === 'out'
  if (!gameState.handActive) {
    return {
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      canAllIn: false,
      callAmount: 0,
      minRaiseAmount: gameState.currentBet + 1,
      disabledReason: 'Раздача не активна'
    }
  }

  if (!gameState.isCurrentPlayer) {
    const callAmount = calculateCallAmount(player, gameState.currentBet)
    return {
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      canAllIn: false,
      callAmount,
      minRaiseAmount: Math.max(gameState.currentBet + 1, player.currentBet + 1),
      disabledReason: 'Сейчас ход другого игрока'
    }
  }

  if (inactive) {
    const callAmount = calculateCallAmount(player, gameState.currentBet)
    return {
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      canAllIn: false,
      callAmount,
      minRaiseAmount: Math.max(gameState.currentBet + 1, player.currentBet + 1),
      disabledReason: 'Игрок не может действовать в этой раздаче'
    }
  }

  const callAmount = calculateCallAmount(player, gameState.currentBet)
  const canCheck = player.currentBet === gameState.currentBet
  const canCall = callAmount > 0 && player.stack > 0
  const canBet = gameState.currentBet === 0 && player.stack > 0
  const canRaise = gameState.currentBet > 0 && player.stack > callAmount
  const canFold = player.status === 'active' || player.status === 'checked' || player.status === 'waiting'
  const canAllIn = player.stack > 0

  return {
    canCheck,
    canCall,
    canBet,
    canRaise,
    canFold,
    canAllIn,
    callAmount,
    minRaiseAmount: Math.max(gameState.currentBet + 1, player.currentBet + 1)
  }
}
