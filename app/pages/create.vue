<script setup lang="ts">
import { usePlayerSessionStore } from "~/stores/playerSession"
const sessionStore = usePlayerSessionStore()

const form = reactive({
  name: 'Домашняя игра',
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 8,
  allowLateJoin: false,
  requireDealerActionApproval: true,
  allowSpectators: true
})

const isSubmitting = ref(false)

async function submit() {
  isSubmitting.value = true
  try {
    const response = await $fetch<{
      roomCode: string
      dealerUrl: string
      joinUrl: string
      dealerSecret: string
    }>('/api/rooms/create', {
      method: 'POST',
      body: form
    })

    sessionStore.saveSession({
      roomCode: response.roomCode,
      playerId: null,
      participantId: null,
      role: 'dealer',
      token: null,
      dealerSecret: response.dealerSecret
    })

    await navigateTo(`/room/${response.roomCode}/dealer`)
  } catch (error) {
    alert(error instanceof Error ? error.message : 'Не удалось создать комнату')
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <main class="page-shell create-room-page">
    <header>
      <h1 class="page-title">Создать онлайн-комнату</h1>
      <p class="page-subtitle">Запустите мультиплеерный стол и пригласите игроков по коду.</p>
    </header>

    <form class="panel create-room-page__form" @submit.prevent="submit">
      <label>
        <span>Название сессии</span>
        <input v-model="form.name" class="input" type="text" required>
      </label>

      <label>
        <span>Стартовый стек</span>
        <input v-model.number="form.startingStack" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Малый блайнд</span>
        <input v-model.number="form.smallBlind" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Большой блайнд</span>
        <input v-model.number="form.bigBlind" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Максимум игроков</span>
        <input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="10" required>
      </label>

      <label class="check">
        <input v-model="form.allowLateJoin" type="checkbox">
        <span>Разрешить поздний вход</span>
      </label>

      <label class="check">
        <input v-model="form.requireDealerActionApproval" type="checkbox">
        <span>Требовать подтверждение дилером</span>
      </label>

      <label class="check">
        <input v-model="form.allowSpectators" type="checkbox">
        <span>Разрешить зрителей</span>
      </label>

      <button type="submit" class="btn" :disabled="isSubmitting">Создать комнату</button>
    </form>
  </main>
</template>

<style scoped lang="scss">
.create-room-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__form {
    display: grid;
    gap: 0.75rem;

    label {
      display: grid;
      gap: 0.35rem;

      span {
        color: var(--text-muted);
        font-size: var(--text-sm);
      }
    }
  }
}

.check {
  display: flex !important;
  gap: 0.5rem;
  align-items: center;
}
</style>
