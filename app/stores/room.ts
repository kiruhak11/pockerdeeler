import type { OnlineGameSession, OnlineHand, OnlinePlayerAction, Player } from '~/types/game'
import type { Room } from '~/types/room'
import type { RoomChatMessage } from '~/types/social'
import type { ConnectionStatus, UncertainPlayerAction } from '~/types/realtime'

interface RoomStoreState {
  room: Room | null
  players: Player[]
  currentSession: OnlineGameSession | null
  currentHand: OnlineHand | null
  actions: OnlinePlayerAction[]
  pendingActions: OnlinePlayerAction[]
  chatMessages: RoomChatMessage[]
  lastDistribution: import('~/types/room').RoomState['lastDistribution']
  connectionStatus: ConnectionStatus
  isStateFresh: boolean
  actionBusy: boolean
  uncertainAction: UncertainPlayerAction | null
  recoveryMessage: string | null
  retryConnectionRequest: number
  retryActionRequest: number
  retryActionDeliveryRequest: number
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
    chatMessages: [],
    lastDistribution: null,
    connectionStatus: 'disconnected',
    isStateFresh: false,
    actionBusy: false,
    uncertainAction: null,
    recoveryMessage: null,
    retryConnectionRequest: 0,
    retryActionRequest: 0,
    retryActionDeliveryRequest: 0,
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
      chatMessages: RoomChatMessage[]
      lastDistribution: import('~/types/room').RoomState['lastDistribution']
    }) {
      if (!Number.isSafeInteger(payload.room.revision)) return false
      if (this.room?.id === payload.room.id && this.room.revision > payload.room.revision) return false
      this.room = payload.room
      this.players = payload.players
      this.currentSession = payload.currentSession
      this.currentHand = payload.currentHand
      this.actions = payload.actions
      this.pendingActions = payload.pendingActions
      this.chatMessages = payload.chatMessages
      this.lastDistribution = payload.lastDistribution
      this.error = null
      return true
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
      this.isStateFresh = status === 'connected'
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
      this.chatMessages = []
      this.lastDistribution = null
      this.connectionStatus = 'disconnected'
      this.isStateFresh = false
      this.actionBusy = false
      this.uncertainAction = null
      this.recoveryMessage = null
      this.error = null
      this.isLoading = false
    }
  }
})
