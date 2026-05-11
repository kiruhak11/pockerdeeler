<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  player: Player
}>()
</script>

<template>
  <article class="dealer-player-card" :class="`dealer-player-card--${player.status}`">
    <header>
      <strong>{{ player.name }}</strong>
      <span class="tag">{{ player.status }}</span>
    </header>
    <p>Место: {{ player.seat }}</p>
    <p>Стек: {{ player.stack }}</p>
    <p>Ставка: {{ player.currentBet }}</p>
    <p>Вложено: {{ player.totalCommitted }}</p>
  </article>
</template>

<style scoped lang="scss">
.dealer-player-card {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius-md);
  padding: 0.7rem;
  background: rgba(255, 255, 255, 0.04);

  header,
  p {
    margin: 0;
  }

  p {
    margin-top: 0.3rem;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
}
</style>
