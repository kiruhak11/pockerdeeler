<script setup lang="ts">
import type { OnlinePlayerAction, Player, OnlineHand } from '~/types/game'
import DealerControls from './DealerControls.vue'
import PendingActions from './PendingActions.vue'
import PotDistributionPreview from './PotDistributionPreview.vue'
import DealerWinnerSelector from './WinnerSelector.vue'
import DealerPlayerCard from './DealerPlayerCard.vue'
import DealerActionLog from './DealerActionLog.vue'

const props = defineProps<{
  players: Player[]
  actions: OnlinePlayerAction[]
  pendingActions: OnlinePlayerAction[]
  currentHand: OnlineHand | null
}>()

const emit = defineEmits<{
  'start-game': []
  'start-hand': []
  'finish-hand': []
  'undo': []
  approve: [actionId: string]
  reject: [actionId: string]
  distribute: [winnerIds: string[]]
}>()
</script>

<template>
  <section class="dealer-dashboard">
    <DealerControls
      @start-game="emit('start-game')"
      @start-hand="emit('start-hand')"
      @finish-hand="emit('finish-hand')"
      @undo="emit('undo')"
    />

    <PendingActions :pending-actions="pendingActions" :players="players" @approve="emit('approve', $event)" @reject="emit('reject', $event)" />

    <PotDistributionPreview :pot="currentHand?.pot || 0" :players="players" />

    <DealerWinnerSelector :players="players" @distribute="emit('distribute', $event)" />

    <section class="dealer-dashboard__players">
      <DealerPlayerCard v-for="player in players" :key="player.id" :player="player" />
    </section>

    <DealerActionLog :actions="actions" :players="players" />
  </section>
</template>

<style scoped lang="scss">
.dealer-dashboard {
  display: grid;
  gap: 0.8rem;

  &__players {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
}
</style>
