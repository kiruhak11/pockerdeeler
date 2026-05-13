<script setup lang="ts">
import { useGameStore } from '~/stores/game'
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'

const gameStore = useGameStore()
const accountStore = useAccountStore()
const { register, login, loadMe, logout } = useAccountAuth()

const roomCode = ref('')
const authForm = reactive({
  username: '',
  password: ''
})
const authError = ref('')
const authLoading = ref(false)

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }

  accountStore.loadSession()
  if (accountStore.token) {
    loadMe().catch(() => {
      accountStore.clearSession()
    })
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

async function registerAccount() {
  authLoading.value = true
  authError.value = ''
  try {
    await register(authForm.username, authForm.password)
  } catch (error) {
    authError.value = getHttpErrorMessage(error, 'Ошибка регистрации')
  } finally {
    authLoading.value = false
  }
}

async function loginAccount() {
  authLoading.value = true
  authError.value = ''
  try {
    await login(authForm.username, authForm.password)
  } catch (error) {
    authError.value = getHttpErrorMessage(error, 'Ошибка входа')
  } finally {
    authLoading.value = false
  }
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

      <section class="home-page__account panel">
        <h2>Аккаунт</h2>
        <p v-if="accountStore.user" class="home-page__hint">
          Вы вошли как <strong>{{ accountStore.user.username }}</strong>. Баланс: <strong>{{ accountStore.user.balance }}</strong>
        </p>

        <template v-if="!accountStore.user">
          <div class="home-page__account-row">
            <input v-model="authForm.username" class="input" type="text" placeholder="Логин">
            <input v-model="authForm.password" class="input" type="password" placeholder="Пароль">
          </div>
          <div class="home-page__actions">
            <button type="button" class="btn" :disabled="authLoading" @click="loginAccount">Войти</button>
            <button type="button" class="btn btn--ghost" :disabled="authLoading" @click="registerAccount">Создать аккаунт</button>
          </div>
          <p v-if="authError" class="home-page__error">{{ authError }}</p>
        </template>

        <button v-else type="button" class="btn btn--ghost" @click="logout">Выйти</button>
      </section>

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

  &__account {
    display: grid;
    gap: 0.6rem;
    text-align: left;

    h2 {
      margin: 0;
      font-size: 1.1rem;
    }
  }

  &__error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
  }

  &__join-row {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: 1fr auto;
  }

  &__account-row {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 680px) {
  .home-page {
    &__hero {
      text-align: left;
    }

    &__actions,
    &__join-row,
    &__account-row {
      grid-template-columns: 1fr;
    }
  }
}
</style>
