<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  players: Player[]
}>()
</script>

<template>
  <section class="panel player-lobby-list">
    <h3>Игроки</h3>
    <p v-if="players.length === 0">Пока пусто</p>
    <ul v-else>
      <li v-for="player in players" :key="player.id">
        <span>{{ player.seat }}.</span>
        <span>{{ player.name }}</span>
        <span class="stack">{{ player.stack }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.player-lobby-list {
  h3,
  p {
    margin: 0;
  }

  ul {
    margin: 0.7rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.45rem;
  }

  li {
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
  }

  .stack {
    color: var(--accent-strong);
  }
}
</style>
