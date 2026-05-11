<script setup lang="ts">
import { useGameStore } from "~/stores/game"
const gameStore = useGameStore()

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }
})
</script>

<template>
  <NuxtPage />
  <ToastList />
</template>
