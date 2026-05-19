<script setup lang="ts">
import { usePlayerSessionStore } from "~/stores/playerSession"
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { parseQuickBetSteps, formatQuickBetSteps } from '~/utils/quickBetSteps'
const sessionStore = usePlayerSessionStore()
const accountStore = useAccountStore()
const { loadMe } = useAccountAuth()

const form = reactive({
  name: 'Домашняя игра',
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 8,
  quickBetStepsText: formatQuickBetSteps([50, 100, 500]),
  allowLateJoin: false,
  requireDealerActionApproval: true,
  allowSpectators: true
})

const isSubmitting = ref(false)

onMounted(async () => {
  accountStore.loadSession()
  if (accountStore.token) {
    await loadMe().catch(() => accountStore.clearSession())
  }
})

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
      body: {
        ...form,
        quickBetSteps: parseQuickBetSteps(form.quickBetStepsText),
        authToken: accountStore.token || undefined
      }
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
      <p v-if="accountStore.user" class="page-subtitle">
        Комната будет связана с аккаунтом: <strong>{{ accountStore.user.username }}</strong>
      </p>
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

      <label>
        <span>Быстрые кнопки ставок (через запятую)</span>
        <input v-model="form.quickBetStepsText" class="input" type="text" placeholder="50, 100, 500">
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
