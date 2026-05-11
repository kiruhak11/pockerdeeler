import type { OnlineGameSession, OnlineHand, OnlinePlayerAction, Player } from '~/types/game'
import type { Room } from '~/types/room'

interface RoomStoreState {
  room: Room | null
  players: Player[]
  currentSession: OnlineGameSession | null
  currentHand: OnlineHand | null
  actions: OnlinePlayerAction[]
  pendingActions: OnlinePlayerAction[]
  lastDistribution: import('~/types/room').RoomState['lastDistribution']
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  error: string | null
  isLoading: boolean
}

export const useRoomStore = defineStore('room', {
  state: (): RoomStoreState => ({
    room: null,
    players: [],
    currentSession: null,
    currentHand: null,
    actions: [],
    pendingActions: [],
    lastDistribution: null,
    connectionStatus: 'disconnected',
    error: null,
    isLoading: false
  }),

  actions: {
    setRoomState(payload: {
      room: Room
      players: Player[]
      currentSession: OnlineGameSession | null
      currentHand: OnlineHand | null
      actions: OnlinePlayerAction[]
      pendingActions: OnlinePlayerAction[]
      lastDistribution: import('~/types/room').RoomState['lastDistribution']
    }) {
      this.room = payload.room
      this.players = payload.players
      this.currentSession = payload.currentSession
      this.currentHand = payload.currentHand
      this.actions = payload.actions
      this.pendingActions = payload.pendingActions
      this.lastDistribution = payload.lastDistribution
      this.error = null
    },

    updatePlayer(player: Player) {
      const index = this.players.findIndex((item) => item.id === player.id)
      if (index < 0) {
        this.players.push(player)
        return
      }

      this.players[index] = player
    },

    addAction(action: OnlinePlayerAction) {
      this.actions.push(action)
      if (action.status === 'pending') {
        this.pendingActions.push(action)
      }
    },

    setConnectionStatus(status: RoomStoreState['connectionStatus']) {
      this.connectionStatus = status
    },

    setError(message: string | null) {
      this.error = message
    },

    resetRoom() {
      this.room = null
      this.players = []
      this.currentSession = null
      this.currentHand = null
      this.actions = []
      this.pendingActions = []
      this.lastDistribution = null
      this.connectionStatus = 'disconnected'
      this.error = null
      this.isLoading = false
    }
  }
})
