<script setup lang="ts">
import { useGameStore } from "~/stores/game"
const gameStore = useGameStore()

onMounted(async () => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }

  if (!gameStore.game) {
    await navigateTo('/')
  }
})

const history = computed(() => gameStore.game?.history ?? [])
</script>

<template>
  <main class="page-shell history-page">
    <header class="history-page__head">
      <div>
        <h1 class="page-title">История раздач</h1>
        <p class="page-subtitle">Просмотр банка, победителей и изменений стеков по каждой раздаче.</p>
      </div>
      <NuxtLink class="btn btn--ghost" to="/game">Назад к игре</NuxtLink>
    </header>

    <HandHistoryList :history="history" />
  </main>
</template>

<style scoped lang="scss">
.history-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }
}

@media (max-width: 760px) {
  .history-page {
    &__head {
      flex-direction: column;
    }
  }
}
</style>
