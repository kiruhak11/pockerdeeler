<script setup lang="ts">
import type { OnlinePlayerAction, Player } from '~/types/game'

const props = defineProps<{
  actions: OnlinePlayerAction[]
  players: Player[]
}>()

function nameById(playerId: string) {
  return props.players.find((player) => player.id === playerId)?.name ?? playerId
}
</script>

<template>
  <section class="panel dealer-action-log">
    <h3>История действий</h3>
    <p v-if="actions.length === 0">Пока пусто</p>
    <ul v-else>
      <li v-for="action in actions" :key="action.id">
        <span>{{ nameById(action.playerId) }}</span>
        <span>{{ action.type }}</span>
        <span>{{ action.amount }}</span>
        <span>{{ action.status }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.dealer-action-log {
  h3,
  p {
    margin: 0;
  }

  ul {
    margin: 0.6rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.35rem;
  }

  li {
    display: grid;
    grid-template-columns: 1.3fr 1fr auto auto;
    gap: 0.45rem;
    font-size: var(--text-sm);
  }
}
</style>
