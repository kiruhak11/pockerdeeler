<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  pot: number
  players: Player[]
}>()
</script>

<template>
  <section class="panel">
    <h3>Банк: {{ pot }}</h3>
    <p>Игроков в раздаче: {{ players.filter((p) => p.status !== 'folded' && p.status !== 'out').length }}</p>
  </section>
</template>
