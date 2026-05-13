<script setup lang="ts">
import type { OnlineGameSession, OnlineHand, OnlinePlayerAction, Player } from '~/types/game'
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
  currentSession: OnlineGameSession | null
  currentHand: OnlineHand | null
}>()

const emit = defineEmits<{
  'start-game': []
  'restart-game': []
  'start-hand': []
  'finish-hand': []
  'undo': []
  approve: [actionId: string]
  reject: [actionId: string]
  distribute: [winnerIds: string[]]
  selectPlayer: [playerId: string]
}>()

const connectedPlayers = computed(() =>
  props.players.filter((player) => player.isConnected !== false && Boolean(player.participantId))
)

const tablePlayers = computed(() =>
  props.players.filter((player) => player.isConnected !== false || player.status !== 'out')
)

const currentPlayer = computed(() => {
  if (!props.currentSession?.currentPlayerId) {
    return null
  }

  return tablePlayers.value.find((player) => player.id === props.currentSession?.currentPlayerId) ?? null
})

const dealerButtonPlayer = computed(() => {
  if (!props.currentSession?.dealerButtonPlayerId) {
    return null
  }

  return tablePlayers.value.find((player) => player.id === props.currentSession?.dealerButtonPlayerId) ?? null
})

const smallBlindPlayer = computed(() => {
  if (!props.currentSession?.smallBlindPlayerId) {
    return null
  }

  return tablePlayers.value.find((player) => player.id === props.currentSession?.smallBlindPlayerId) ?? null
})

const bigBlindPlayer = computed(() => {
  if (!props.currentSession?.bigBlindPlayerId) {
    return null
  }

  return tablePlayers.value.find((player) => player.id === props.currentSession?.bigBlindPlayerId) ?? null
})

const canRestartGame = computed(() => connectedPlayers.value.filter((player) => player.stack > 0).length === 1)
</script>

<template>
  <section class="dealer-dashboard">
    <section class="panel dealer-dashboard__meta">
      <p><strong>Сейчас ходит:</strong> {{ currentPlayer?.name || '—' }}</p>
      <p><strong>Дилер:</strong> {{ dealerButtonPlayer?.name || '—' }}</p>
      <p><strong>SB/BB:</strong> {{ smallBlindPlayer?.name || '—' }} / {{ bigBlindPlayer?.name || '—' }}</p>
    </section>

    <DealerControls
      :can-restart-game="canRestartGame"
      @start-game="emit('start-game')"
      @restart-game="emit('restart-game')"
      @start-hand="emit('start-hand')"
      @finish-hand="emit('finish-hand')"
      @undo="emit('undo')"
    />

    <PendingActions :pending-actions="pendingActions" :players="players" @approve="emit('approve', $event)" @reject="emit('reject', $event)" />

    <PotDistributionPreview :pot="currentHand?.pot || 0" :players="players" />

    <DealerWinnerSelector :players="players" @distribute="emit('distribute', $event)" />

    <section class="dealer-dashboard__players">
      <DealerPlayerCard
        v-for="player in tablePlayers"
        :key="player.id"
        :player="player"
        :is-current-player="currentSession?.currentPlayerId === player.id"
        :is-dealer-button="currentSession?.dealerButtonPlayerId === player.id"
        :is-small-blind="currentSession?.smallBlindPlayerId === player.id"
        :is-big-blind="currentSession?.bigBlindPlayerId === player.id"
        @select="emit('selectPlayer', $event)"
      />
    </section>

    <DealerActionLog :actions="actions" :players="players" />
  </section>
</template>

<style scoped lang="scss">
.dealer-dashboard {
  display: grid;
  gap: 0.8rem;

  &__meta {
    display: grid;
    gap: 0.35rem;

    p {
      margin: 0;
      color: var(--text-muted);
    }

    strong {
      color: var(--text);
    }
  }

  &__players {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
}
</style>
