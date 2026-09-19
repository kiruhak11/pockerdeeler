<script setup lang="ts">
import DailyBonusCard from './DailyBonusCard.vue'
defineProps<{ inGame?: boolean }>()
</script>

<template>
  <DailyBonusCard :in-game="inGame" />
</template>
