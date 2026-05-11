<script setup lang="ts">
import { useGameStore } from '~/stores/game'

const gameStore = useGameStore()

const roomCode = ref('')

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }
})

const hasSaved = computed(() => gameStore.canContinue)

async function startNewLocalGame() {
  gameStore.resetGame()
  await navigateTo('/setup')
}

async function continueLocalGame() {
  gameStore.loadFromLocalStorage()
  if (!gameStore.game) {
    gameStore.pushToast('Сохраненной игры не найдено.')
    return
  }

  await navigateTo('/game')
}

async function joinByCode() {
  const code = roomCode.value.trim().toUpperCase()
  if (!code) {
    return
  }

  await navigateTo(`/room/${code}/join`)
}
</script>

<template>
  <main class="page-shell home-page">
    <section class="panel home-page__hero">
      <h1 class="page-title">Poker Dealer Desk</h1>
      <p class="page-subtitle">
        Локальный режим дилера и онлайн-комнаты с игроками по коду.
      </p>

      <div class="home-page__actions">
        <button type="button" class="btn" @click="startNewLocalGame">Локальная игра</button>
        <button type="button" class="btn btn--ghost" :disabled="!hasSaved" @click="continueLocalGame">
          Продолжить локальную
        </button>
      </div>

      <div class="home-page__actions">
        <NuxtLink class="btn" to="/create">Создать комнату</NuxtLink>
      </div>

      <div class="home-page__join panel">
        <h2>Присоединиться по коду</h2>
        <div class="home-page__join-row">
          <input v-model="roomCode" class="input" type="text" placeholder="Например: A7K2M9">
          <button type="button" class="btn" @click="joinByCode">Войти</button>
        </div>
      </div>

      <p v-if="!hasSaved" class="home-page__hint">Нет сохраненной локальной игры.</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.home-page {
  min-height: 100svh;
  display: grid;
  place-items: center;

  &__hero {
    width: min(100%, 680px);
    display: grid;
    gap: 1rem;
    text-align: center;
    padding: 1.2rem;
  }

  &__actions {
    display: grid;
    gap: 0.7rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  &__hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__join {
    text-align: left;
    display: grid;
    gap: 0.6rem;

    h2 {
      margin: 0;
      font-size: 1.1rem;
    }
  }

  &__join-row {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: 1fr auto;
  }
}

@media (max-width: 680px) {
  .home-page {
    &__hero {
      text-align: left;
    }

    &__actions,
    &__join-row {
      grid-template-columns: 1fr;
    }
  }
}
</style>
