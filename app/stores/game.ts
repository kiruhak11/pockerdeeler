import { defineStore } from "pinia"
import type {
  ActionInput,
  Game,
  GameSnapshot,
  HandHistory,
  Player,
  ToastMessage,
  WinnerResult
} from '../types/game'
import {
  applyPlayerAction,
  chipsInvariant,
  clonePlayers,
  distributePot,
  resetPlayersForNewHand,
  sumCommitted
} from '../utils/pokerCalculations'
import {
  clearGameFromStorage,
  hasSavedGame,
  loadGameFromStorage,
  saveGameToStorage
} from '../utils/storage'

const DEFAULT_SMALL_BLIND = 5
const DEFAULT_BIG_BLIND = 10
const DEFAULT_QUICK_RAISE_STEPS = [10, 25, 50, 100]

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function assignMissingSeats(players: Player[]): void {
  const usedSeats = new Set<number>()
  let nextSeat = 1

  const takeNextSeat = () => {
    while (usedSeats.has(nextSeat)) {
      nextSeat += 1
    }

    const seat = nextSeat
    usedSeats.add(seat)
    nextSeat += 1
    return seat
  }

  for (const player of players) {
    const seat = player.seat === undefined ? undefined : Math.trunc(player.seat)
    if (seat && seat > 0 && !usedSeats.has(seat)) {
      usedSeats.add(seat)
      player.seat = seat
      continue
    }

    player.seat = takeNextSeat()
  }
}

function sanitizeQuickSteps(steps: number[]): number[] {
  const normalized = steps
    .map((value) => Math.trunc(value))
    .filter((value) => value > 0)
    .slice(0, 6)

  if (!normalized.length) {
    return [...DEFAULT_QUICK_RAISE_STEPS]
  }

  return normalized
}

function createEmptyGame(): Game {
  return {
    id: uid('game'),
    variant: 'texas-holdem',
    smallBlind: DEFAULT_SMALL_BLIND,
    bigBlind: DEFAULT_BIG_BLIND,
    quickRaiseSteps: [...DEFAULT_QUICK_RAISE_STEPS],
    players: [],
    pot: 0,
    currentBet: 0,
    handNumber: 0,
    handActive: false,
    handStage: 'setup',
    history: [],
    actions: [],
    pendingWinners: [],
    handStartedAt: Date.now(),
    tableChipsTotal: 0
  }
}

function cloneActions<T>(actions: T[]): T[] {
  return actions.map((item) => ({ ...item }))
}

function createSnapshot(game: Game): GameSnapshot {
  return {
    players: clonePlayers(game.players),
    pot: game.pot,
    currentBet: game.currentBet,
    actions: cloneActions(game.actions),
    handActive: game.handActive,
    handStage: game.handStage,
    pendingWinners: [...game.pendingWinners]
  }
}

function restoreSnapshot(game: Game, snapshot: GameSnapshot): void {
  game.players = clonePlayers(snapshot.players)
  game.pot = snapshot.pot
  game.currentBet = snapshot.currentBet
  game.actions = cloneActions(snapshot.actions)
  game.handActive = snapshot.handActive
  game.handStage = snapshot.handStage
  game.pendingWinners = [...snapshot.pendingWinners]
}

function hasEnoughPlayersToPlay(players: Player[]): boolean {
  return players.filter((player) => player.stack > 0).length >= 2
}

function mapWinnersById(winners: WinnerResult[]): Set<string> {
  return new Set(winners.map((winner) => winner.playerId))
}

function postBlind(player: Player, amount: number): number {
  const applied = Math.max(0, Math.min(player.stack, Math.trunc(amount)))
  if (applied <= 0) {
    return 0
  }

  player.stack -= applied
  player.currentBet += applied
  player.totalCommitted += applied
  player.status = player.stack === 0 ? 'all-in' : 'active'
  return applied
}

function applyForcedBlinds(players: Player[], smallBlind: number, bigBlind: number): { pot: number; currentBet: number } {
  const active = players
    .filter((player) => player.status !== 'out')
    .sort((a, b) => (a.seat ?? Number.MAX_SAFE_INTEGER) - (b.seat ?? Number.MAX_SAFE_INTEGER))

  if (active.length < 2) {
    return {
      pot: sumCommitted(players),
      currentBet: 0
    }
  }

  const smallBlindPlayer = active[0]!
  const bigBlindPlayer = active[1]!

  postBlind(smallBlindPlayer, smallBlind)
  postBlind(bigBlindPlayer, bigBlind)

  return {
    pot: sumCommitted(players),
    currentBet: Math.max(...players.map((player) => player.currentBet), 0)
  }
}

export const useGameStore = defineStore('game', {
  state: () => ({
    game: null as Game | null,
    undoStack: [] as GameSnapshot[],
    handStartPlayers: [] as Player[],
    notifications: [] as ToastMessage[],
    hydrated: false,
    hasPersistedState: false
  }),

  getters: {
    players(state): Player[] {
      return state.game?.players ?? []
    },
    pot(state): number {
      return state.game?.pot ?? 0
    },
    canContinue(state): boolean {
      return state.hasPersistedState || hasSavedGame()
    }
  },

  actions: {
    pushToast(text: string, type: ToastMessage['type'] = 'error') {
      this.notifications.push({
        id: uid('toast'),
        text,
        type
      })
    },

    removeToast(id: string) {
      this.notifications = this.notifications.filter((toast) => toast.id !== id)
    },

    ensureGame() {
      if (!this.game) {
        this.game = createEmptyGame()
      }
      return this.game
    },

    setRoomSettings(payload: { variant?: Game['variant']; smallBlind: number; bigBlind: number; quickRaiseSteps: number[] }) {
      const game = this.ensureGame()
      if (game.handStage !== 'setup') {
        this.pushToast('Настройки стола можно менять только до старта игры.')
        return false
      }

      const smallBlind = Math.trunc(payload.smallBlind)
      const bigBlind = Math.trunc(payload.bigBlind)
      const quickRaiseSteps = sanitizeQuickSteps(payload.quickRaiseSteps)

      if (smallBlind <= 0) {
        this.pushToast('Малый блайнд должен быть больше 0.')
        return false
      }
      if (bigBlind <= smallBlind) {
        this.pushToast('Большой блайнд должен быть больше малого.')
        return false
      }

      game.variant = payload.variant ?? game.variant
      game.smallBlind = smallBlind
      game.bigBlind = bigBlind
      game.quickRaiseSteps = quickRaiseSteps

      this.saveToLocalStorage()
      return true
    },

    addPlayer(payload: { name: string; stack: number; seat?: number | null | '' }) {
      const game = this.ensureGame()
      if (game.handStage !== 'setup') {
        this.pushToast('Добавлять игроков можно только на этапе настройки.')
        return
      }

      const name = payload.name.trim()
      const stack = Math.trunc(payload.stack)
      const seat = payload.seat === undefined || payload.seat === null || payload.seat === ''
        ? undefined
        : Math.trunc(payload.seat)

      if (!name) {
        this.pushToast('Введите имя игрока.')
        return
      }
      if (stack <= 0) {
        this.pushToast('Стартовый стек должен быть больше 0.')
        return
      }
      if (seat !== undefined && seat <= 0) {
        this.pushToast('Номер позиции должен быть больше 0.')
        return
      }

      game.players.push({
        id: uid('player'),
        name,
        stack,
        seat,
        currentBet: 0,
        totalCommitted: 0,
        status: 'active'
      })

      assignMissingSeats(game.players)
      this.saveToLocalStorage()
    },

    removePlayer(playerId: string) {
      const game = this.ensureGame()
      if (game.handStage !== 'setup') {
        this.pushToast('Удалять игроков можно только на этапе настройки.')
        return
      }

      game.players = game.players.filter((player) => player.id !== playerId)
      assignMissingSeats(game.players)
      this.saveToLocalStorage()
    },

    updatePlayer(
      playerId: string,
      payload: Partial<Pick<Player, 'name' | 'stack'>> & { seat?: number | null | '' }
    ) {
      const game = this.ensureGame()
      if (game.handStage !== 'setup') {
        this.pushToast('Редактирование игроков доступно только до старта игры.')
        return
      }

      const player = game.players.find((item) => item.id === playerId)
      if (!player) {
        this.pushToast('Игрок не найден.')
        return
      }

      if (payload.name !== undefined) {
        const name = payload.name.trim()
        if (!name) {
          this.pushToast('Имя игрока не может быть пустым.')
          return
        }
        player.name = name
      }

      if (payload.stack !== undefined) {
        const stack = Math.trunc(payload.stack)
        if (stack <= 0) {
          this.pushToast('Стек должен быть больше 0.')
          return
        }
        player.stack = stack
      }

      if (payload.seat !== undefined) {
        const seat = payload.seat
        if (seat === null || seat === '') {
          player.seat = undefined
        } else {
          const normalized = Math.trunc(seat)
          if (normalized <= 0) {
            this.pushToast('Позиция должна быть больше 0.')
            return
          }
          player.seat = normalized
        }
      }

      assignMissingSeats(game.players)
      this.saveToLocalStorage()
    },

    startGame() {
      const game = this.ensureGame()
      if (game.players.length < 2) {
        this.pushToast('Для старта нужно минимум 2 игрока.')
        return false
      }

      assignMissingSeats(game.players)
      game.players = resetPlayersForNewHand(game.players)
      if (!hasEnoughPlayersToPlay(game.players)) {
        this.pushToast('Для игры нужно минимум 2 игрока с фишками.')
        return false
      }

      game.pot = 0
      game.currentBet = 0
      game.handNumber = 1
      game.handActive = true
      game.handStage = 'playing'
      game.history = []
      game.actions = []
      game.pendingWinners = []
      game.handStartedAt = Date.now()
      game.tableChipsTotal = game.players.reduce((sum, player) => sum + player.stack, 0)

      const forced = applyForcedBlinds(game.players, game.smallBlind, game.bigBlind)
      game.pot = forced.pot
      game.currentBet = forced.currentBet

      this.undoStack = []
      this.handStartPlayers = clonePlayers(game.players)
      this.saveToLocalStorage()
      return true
    },

    startNewHand() {
      const game = this.game
      if (!game) {
        this.pushToast('Сначала создайте игру.')
        return false
      }

      if (!hasEnoughPlayersToPlay(game.players)) {
        this.pushToast('Невозможно начать раздачу: осталось меньше двух игроков с фишками.')
        return false
      }

      assignMissingSeats(game.players)
      game.players = resetPlayersForNewHand(game.players)
      game.pot = 0
      game.currentBet = 0
      game.actions = []
      game.pendingWinners = []
      game.handActive = true
      game.handStage = 'playing'
      game.handNumber = Math.max(1, game.handNumber + 1)
      game.handStartedAt = Date.now()

      const forced = applyForcedBlinds(game.players, game.smallBlind, game.bigBlind)
      game.pot = forced.pot
      game.currentBet = forced.currentBet

      this.undoStack = []
      this.handStartPlayers = clonePlayers(game.players)
      this.saveToLocalStorage()
      return true
    },

    performAction(input: ActionInput) {
      const game = this.game
      if (!game) {
        this.pushToast('Игра не создана.')
        return
      }
      if (!game.handActive || game.handStage !== 'playing') {
        this.pushToast('Сначала начните раздачу.')
        return
      }

      try {
        this.undoStack.push(createSnapshot(game))

        const result = applyPlayerAction(game.players, game.pot, game.currentBet, input)
        game.players = result.players
        game.currentBet = result.currentBet
        game.actions.push(result.action)
        game.pot = sumCommitted(game.players)

        this.saveToLocalStorage()
      } catch (error) {
        this.undoStack.pop()
        const message = error instanceof Error ? error.message : 'Не удалось выполнить действие.'
        this.pushToast(message)
      }
    },

    undoLastAction() {
      const game = this.game
      if (!game) {
        this.pushToast('Нет активной игры.')
        return
      }
      if (game.handStage !== 'playing') {
        this.pushToast('Отмена действия доступна только во время раздачи.')
        return
      }

      const snapshot = this.undoStack.pop()
      if (!snapshot) {
        this.pushToast('Нет действий для отмены.', 'info')
        return
      }

      restoreSnapshot(game, snapshot)
      this.saveToLocalStorage()
    },

    resetCurrentHand() {
      const game = this.game
      if (!game) {
        this.pushToast('Нет активной игры.')
        return
      }
      if (game.handStage === 'completed') {
        this.pushToast('Сначала начните новую раздачу.')
        return
      }

      const restoredPlayers = this.handStartPlayers.length
        ? clonePlayers(this.handStartPlayers)
        : resetPlayersForNewHand(game.players)

      game.players = restoredPlayers
      game.pot = 0
      game.currentBet = 0
      game.actions = []
      game.pendingWinners = []
      game.handActive = true
      game.handStage = 'playing'

      this.undoStack = []
      this.saveToLocalStorage()
    },

    finishHand() {
      const game = this.game
      if (!game) {
        this.pushToast('Нет активной игры.')
        return false
      }
      if (!game.handActive || game.handStage !== 'playing') {
        this.pushToast('Раздача уже завершена или не начата.')
        return false
      }

      const eligible = game.players.filter((player) => player.status !== 'folded' && player.status !== 'out')
      if (!eligible.length) {
        this.pushToast('Нет игроков для определения победителя.')
        return false
      }

      game.handActive = false
      game.handStage = 'showdown'

      if (eligible.length === 1) {
        const onlyPlayer = eligible[0]
        game.pendingWinners = onlyPlayer ? [onlyPlayer.id] : []
      } else {
        game.pendingWinners = []
      }

      this.saveToLocalStorage()
      return true
    },

    setPendingWinners(playerIds: string[]) {
      const game = this.game
      if (!game) {
        return
      }

      game.pendingWinners = [...new Set(playerIds)]
      this.saveToLocalStorage()
    },

    distributePot() {
      const game = this.game
      if (!game) {
        this.pushToast('Нет активной игры.')
        return false
      }
      if (game.handStage !== 'showdown') {
        this.pushToast('Сначала завершите раздачу.')
        return false
      }

      try {
        const before = this.handStartPlayers.length ? clonePlayers(this.handStartPlayers) : clonePlayers(game.players)
        const distribution = distributePot(game.players, game.pendingWinners)

        game.players = distribution.players
        game.pot = 0
        game.currentBet = 0
        game.handActive = false
        game.handStage = 'completed'

        const historyItem: HandHistory = {
          handNumber: game.handNumber,
          actions: cloneActions(game.actions),
          pot: sumCommitted(game.players) === 0
            ? distribution.result.winners.reduce((sum, item) => sum + item.amountWon, 0) +
              distribution.result.returned.reduce((sum, item) => sum + item.amountWon, 0)
            : 0,
          winners: [...distribution.result.winners, ...distribution.result.returned],
          playerSnapshotsBefore: before,
          playerSnapshotsAfter: clonePlayers(game.players)
        }

        game.history.unshift(historyItem)
        game.actions = []
        game.pendingWinners = []

        const totalChips = game.tableChipsTotal
        if (!chipsInvariant(game.players, totalChips)) {
          this.pushToast('Проверка инварианта фишек не прошла. Проверьте раздачу.')
        }

        const winnerIds = mapWinnersById(distribution.result.winners)
        const winnerNames = game.players
          .filter((player) => winnerIds.has(player.id))
          .map((player) => player.name)
          .join(', ')

        this.pushToast(
          winnerNames ? `Банк распределен. Победители: ${winnerNames}` : 'Банк распределен.',
          'success'
        )

        this.saveToLocalStorage()
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Не удалось распределить банк.'
        this.pushToast(message)
        return false
      }
    },

    saveToLocalStorage() {
      saveGameToStorage(this.game)
      this.hasPersistedState = Boolean(this.game)
    },

    loadFromLocalStorage() {
      const loaded = loadGameFromStorage()
      if (loaded) {
        loaded.variant = loaded.variant ?? 'texas-holdem'
        loaded.smallBlind = loaded.smallBlind && loaded.smallBlind > 0 ? Math.trunc(loaded.smallBlind) : DEFAULT_SMALL_BLIND
        loaded.bigBlind = loaded.bigBlind && loaded.bigBlind > loaded.smallBlind
          ? Math.trunc(loaded.bigBlind)
          : Math.max(DEFAULT_BIG_BLIND, loaded.smallBlind * 2)
        loaded.quickRaiseSteps = sanitizeQuickSteps(loaded.quickRaiseSteps ?? DEFAULT_QUICK_RAISE_STEPS)
        assignMissingSeats(loaded.players)
        this.game = loaded
        this.hasPersistedState = true
      } else {
        this.hasPersistedState = false
      }

      this.hydrated = true
    },

    syncFromServer(payload: { pot: number; currentBet: number; handNumber: number; status: Game['handStage'] }) {
      const game = this.ensureGame()
      game.pot = payload.pot
      game.currentBet = payload.currentBet
      game.handNumber = payload.handNumber
      game.handStage = payload.status
    },

    clearLocalGame() {
      this.resetGame()
    },

    resetGame() {
      this.game = null
      this.undoStack = []
      this.handStartPlayers = []
      this.notifications = []
      this.hasPersistedState = false
      clearGameFromStorage()
    }
  }
})
