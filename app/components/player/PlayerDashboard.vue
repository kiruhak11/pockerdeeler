<script setup lang="ts">
import type { OnlineHand, Player } from '~/types/game'
import PlayerStackCard from './PlayerStackCard.vue'
import PlayerActionPanel from './PlayerActionPanel.vue'
import PlayerTableView from './PlayerTableView.vue'

const props = defineProps<{
  selfPlayer: Player | null
  players: Player[]
  currentHand: OnlineHand | null
  waitingApproval: boolean
}>()

const emit = defineEmits<{
  action: [payload: { type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'; amount: number }]
}>()
</script>

<template>
  <section class="player-dashboard">
    <PlayerStackCard :player="selfPlayer" :pot="currentHand?.pot || 0" :current-bet="currentHand?.currentBet || 0" />
    <PlayerActionPanel :waiting-approval="waitingApproval" @action="emit('action', $event)" />
    <PlayerTableView :players="players" />
  </section>
</template>

<style scoped lang="scss">
.player-dashboard {
  display: grid;
  gap: 0.8rem;
}
</style>
