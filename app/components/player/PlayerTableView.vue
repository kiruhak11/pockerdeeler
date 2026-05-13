<script setup lang="ts">
import type { Player } from '~/types/game'

const props = defineProps<{
  players: Player[]
  selfPlayerId: string | null
  currentPlayerId: string | null
  smallBlindPlayerId: string | null
  bigBlindPlayerId: string | null
}>()

const visiblePlayers = computed(() =>
  props.players.filter((player) => player.isConnected !== false && Boolean(player.participantId))
)
</script>

<template>
  <section class="panel player-table-view">
    <h3>Стол</h3>
    <ul>
      <li
        v-for="player in visiblePlayers"
        :key="player.id"
        :class="{
          'player-table-view__row--current': props.currentPlayerId === player.id,
          'player-table-view__row--self': props.selfPlayerId === player.id
        }"
      >
        <span>{{ player.seat }}.</span>
        <span class="name">
          {{ player.name }}
          <small v-if="props.selfPlayerId === player.id">(вы)</small>
          <small v-if="props.smallBlindPlayerId === player.id">SB</small>
          <small v-if="props.bigBlindPlayerId === player.id">BB</small>
        </span>
        <span>{{ player.stack }}</span>
        <span class="tag">{{ player.status }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.player-table-view {
  h3 {
    margin: 0;
  }

  ul {
    margin: 0.6rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.4rem;
  }

  li {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: 0.4rem;
    align-items: center;
    padding: 0.35rem 0.45rem;
    border-radius: var(--radius-sm);
  }

  &__row--current {
    background: rgba(255, 196, 0, 0.18);
  }

  &__row--self {
    outline: 1px solid rgba(255, 255, 255, 0.22);
  }

  .name {
    display: flex;
    gap: 0.35rem;
    align-items: baseline;

    small {
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
  }
}
</style>
