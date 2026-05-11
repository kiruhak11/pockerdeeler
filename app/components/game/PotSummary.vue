<script setup lang="ts">
defineProps<{
  pot: number
  currentBet: number
  handNumber: number
}>()
</script>

<template>
  <section class="panel">
    <h3>Банк: {{ pot }}</h3>
    <p>Текущая ставка: {{ currentBet }}</p>
    <p>Раздача: #{{ handNumber }}</p>
  </section>
</template>
