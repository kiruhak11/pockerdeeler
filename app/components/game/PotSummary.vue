<script setup lang="ts">
defineProps<{
  pot: number
  currentBet: number
  handNumber: number
  smallBlind?: number
  bigBlind?: number
  currentPlayerName?: string | null
}>()
</script>

<template>
  <section class="panel">
    <h3>Банк: {{ pot }}</h3>
    <p>Текущая ставка: {{ currentBet }}</p>
    <p>Раздача: #{{ handNumber }}</p>
    <p v-if="smallBlind && bigBlind">Блайнды: {{ smallBlind }}/{{ bigBlind }}</p>
    <p>Сейчас ходит: {{ currentPlayerName || '—' }}</p>
  </section>
</template>
