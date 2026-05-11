<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  players: Player[]
}>()
</script>

<template>
  <section class="panel player-table-view">
    <h3>Стол</h3>
    <ul>
      <li v-for="player in players" :key="player.id">
        <span>{{ player.seat }}.</span>
        <span>{{ player.name }}</span>
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
  }
}
</style>
