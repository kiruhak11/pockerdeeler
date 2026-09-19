<script setup lang="ts">
import type { Player } from '~/types/game'

defineProps<{
  pot: number
  players: Player[]
}>()
</script>

<template>
  <section class="panel">
    <h3>Итоговый банк: {{ pot }}</h3>
    <p>В раздаче участвуют: {{ players.filter((p) => p.status !== 'folded' && p.status !== 'out').length }}</p>
    <p class="page-subtitle">После выбора победителей система автоматически распределит доступные им фишки.</p>
  </section>
</template>
