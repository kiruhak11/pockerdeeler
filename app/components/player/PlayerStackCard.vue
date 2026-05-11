<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  player: Player | null
  pot: number
  currentBet: number
}>()
</script>

<template>
  <section class="panel player-stack-card">
    <h3>Ваш стек: {{ player?.stack ?? '-' }}</h3>
    <p>Банк: {{ pot }}</p>
    <p>Текущая ставка: {{ currentBet }}</p>
    <p>Ваш статус: {{ player?.status ?? '-' }}</p>
  </section>
</template>

<style scoped lang="scss">
.player-stack-card {
  h3,
  p {
    margin: 0;
  }

  p {
    margin-top: 0.35rem;
    color: var(--text-muted);
  }
}
</style>
