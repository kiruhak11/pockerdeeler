<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  players: Player[]
  currentPlayerId?: string | null
  smallBlindPlayerId?: string | null
  bigBlindPlayerId?: string | null
}>()
</script>

<template>
  <section class="panel">
    <h3>Игроки за столом</h3>
    <ul>
      <li
        v-for="player in players"
        :key="player.id"
        :class="{ 'is-current': currentPlayerId === player.id }"
      >
        {{ player.seat }}. {{ player.name }} — {{ player.stack }} ({{ player.status }})
        <span class="marks">
          <span v-if="smallBlindPlayerId === player.id" class="tag">SB</span>
          <span v-if="bigBlindPlayerId === player.id" class="tag">BB</span>
          <span v-if="currentPlayerId === player.id" class="tag">Ход</span>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
ul {
  margin: 0.6rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0.45rem;
  border-radius: var(--radius-sm);
}

.is-current {
  background: rgba(255, 196, 0, 0.18);
}

.marks {
  display: flex;
  gap: 0.3rem;
}
</style>
