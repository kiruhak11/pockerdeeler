<script setup lang="ts">
import type { OnlineGameSession, OnlineHand, OnlinePlayerAction, Player } from '~/types/game'
import DealerControls from './DealerControls.vue'
import PendingActions from './PendingActions.vue'
import PotDistributionPreview from './PotDistributionPreview.vue'
import DealerWinnerSelector from './WinnerSelector.vue'
import DealerPlayerCard from './DealerPlayerCard.vue'
import DealerActionLog from './DealerActionLog.vue'

const props = defineProps<{
  busy?: boolean
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
  distribute: [winnerIds: string[], potWinners?: Record<string, string[]>]
  selectPlayer: [playerId: string]
}>()

const connectedPlayers = computed(() =>
  props.players.filter((player) => player.isConnected !== false && Boolean(player.participantId))
)

const tablePlayers = computed(() => connectedPlayers.value)

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
    <section class="panel dealer-dashboard__turn" :class="{ 'dealer-dashboard__turn--active': currentPlayer }">
      <span class="eyebrow">Очередь хода</span>
      <strong>{{ currentPlayer?.name || 'Раздача завершена' }}</strong>
      <span v-if="currentPlayer">Игрок должен принять решение сейчас</span>
      <span v-else>Запустите новую раздачу, чтобы начать круг ставок</span>
    </section>

    <section class="panel dealer-dashboard__meta">
      <p><strong>Дилер:</strong> {{ dealerButtonPlayer?.name || '—' }}</p>
      <p><strong>Малый блайнд:</strong> {{ smallBlindPlayer?.name || '—' }}</p>
      <p><strong>Большой блайнд:</strong> {{ bigBlindPlayer?.name || '—' }}</p>
    </section>

    <DealerControls
      :busy="busy"
      :session="currentSession"
      :hand="currentHand"
      :can-restart-game="canRestartGame"
      @start-game="emit('start-game')"
      @restart-game="emit('restart-game')"
      @start-hand="emit('start-hand')"
      @finish-hand="emit('finish-hand')"
      @undo="emit('undo')"
    />

    <PendingActions :pending-actions="pendingActions" :players="players" @approve="emit('approve', $event)" @reject="emit('reject', $event)" />

    <PotDistributionPreview :pot="currentHand?.pot || 0" :players="players" />

    <DealerWinnerSelector v-if="currentHand?.status === 'showdown'" :key="currentHand.id" :players="players" :busy="busy" @distribute="(ids, pots) => emit('distribute', ids, pots)" />

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

  &__turn {
    display: grid;
    gap: 0.25rem;
    border-color: rgba(255, 255, 255, 0.14);

    strong {
      font-size: clamp(1.3rem, 3vw, 1.9rem);
    }

    span:last-child {
      color: var(--text-muted);
      font-size: var(--text-sm);
    }

    &--active {
      border-color: rgba(245, 183, 77, 0.8);
      background: linear-gradient(135deg, rgba(245, 183, 77, 0.2), rgba(17, 39, 31, 0.92));
      box-shadow: 0 0 0 1px rgba(245, 183, 77, 0.18), 0 12px 28px rgba(0, 0, 0, 0.14);
    }
  }

  &__players {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }
}
</style>
