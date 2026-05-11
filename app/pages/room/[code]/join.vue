<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"
import { getHttpErrorMessage } from '~/utils/httpError'
const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()

const code = computed(() => String(route.params.code || '').toUpperCase())
const name = ref('')
const asSpectator = ref(false)
const isLoading = ref(false)
const errorMessage = ref('')

const { joinRoom } = usePlayerRoom(code)

onMounted(async () => {
  try {
    const state = await $fetch(`/api/rooms/${code.value}/state`)
    roomStore.setRoomState(state)
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Комната не найдена')
  }
})

async function submit() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    const response = await joinRoom({
      name: name.value,
      role: asSpectator.value ? 'spectator' : 'player'
    }) as {
      roomCode: string
      playerId?: string
      participantId: string
      playerSessionToken: string
      playerUrl: string
    }

    sessionStore.saveSession({
      roomCode: response.roomCode,
      playerId: response.playerId ?? null,
      participantId: response.participantId,
      role: asSpectator.value ? 'spectator' : 'player',
      token: response.playerSessionToken,
      dealerSecret: null
    })

    if (asSpectator.value) {
      await navigateTo(`/room/${code.value}/table`)
    } else {
      await navigateTo(`/room/${code.value}/player`)
    }
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Ошибка входа')
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <main class="page-shell join-room-page">
    <header>
      <h1 class="page-title">Вход в комнату {{ code }}</h1>
      <p class="page-subtitle">Введите имя и подключитесь к столу.</p>
    </header>

    <section class="panel join-room-page__form">
      <label>
        <span>Имя</span>
        <input v-model="name" class="input" type="text" required>
      </label>

      <label class="check">
        <input v-model="asSpectator" type="checkbox">
        <span>Войти как зритель</span>
      </label>

      <button type="button" class="btn" :disabled="isLoading || !name.trim()" @click="submit">
        Присоединиться
      </button>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.join-room-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__form {
    display: grid;
    gap: 0.8rem;
  }
}

.check {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.error {
  color: var(--danger);
  margin: 0;
}
</style>
