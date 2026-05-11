<script setup lang="ts">
import type { AvailableActions, OnlineGameSession, OnlineHand, Player } from '~/types/game'
import { getAvailableActions } from '~/utils/pokerCalculations'
import PlayerStackCard from './PlayerStackCard.vue'
import PlayerActionPanel from './PlayerActionPanel.vue'
import PlayerTableView from './PlayerTableView.vue'

const props = defineProps<{
  selfPlayer: Player | null
  players: Player[]
  currentSession: OnlineGameSession | null
  currentHand: OnlineHand | null
  waitingApproval: boolean
}>()

const emit = defineEmits<{
  action: [payload: { type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'; amount: number }]
}>()

const currentPlayer = computed(() => {
  if (!props.currentSession?.currentPlayerId) {
    return null
  }

  return props.players.find((player) => player.id === props.currentSession?.currentPlayerId) ?? null
})

const isMyTurn = computed(() => {
  if (!props.selfPlayer || !props.currentSession?.currentPlayerId) {
    return false
  }

  return props.currentSession.currentPlayerId === props.selfPlayer.id
})

const availability = computed<AvailableActions>(() => {
  if (!props.selfPlayer) {
    return {
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      canAllIn: false,
      callAmount: 0,
      minRaiseAmount: 1,
      disabledReason: 'Игрок не найден'
    }
  }

  return getAvailableActions(props.selfPlayer, {
    currentBet: props.currentHand?.currentBet ?? 0,
    handActive: props.currentHand?.status === 'active',
    isCurrentPlayer: isMyTurn.value
  })
})
</script>

<template>
  <section class="player-dashboard">
    <PlayerStackCard
      :player="selfPlayer"
      :pot="currentHand?.pot || 0"
      :current-bet="currentHand?.currentBet || 0"
      :call-amount="availability.callAmount"
      :is-my-turn="isMyTurn"
      :current-player-name="currentPlayer?.name || null"
    />

    <PlayerActionPanel
      :waiting-approval="waitingApproval"
      :availability="availability"
      :pot="currentHand?.pot || 0"
      :stack="selfPlayer?.stack || 0"
      @action="emit('action', $event)"
    />

    <PlayerTableView
      :players="players"
      :self-player-id="selfPlayer?.id || null"
      :current-player-id="currentSession?.currentPlayerId || null"
      :small-blind-player-id="currentSession?.smallBlindPlayerId || null"
      :big-blind-player-id="currentSession?.bigBlindPlayerId || null"
    />
  </section>
</template>

<style scoped lang="scss">
.player-dashboard {
  display: grid;
  gap: 0.8rem;
}
</style>
