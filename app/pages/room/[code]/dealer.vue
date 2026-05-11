<script setup lang="ts">
import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import RoomCodeCard from '~/components/room/RoomCodeCard.vue'
import QRCodeInvite from '~/components/room/QRCodeInvite.vue'
import PlayerLobbyList from '~/components/room/PlayerLobbyList.vue'
import DealerDashboard from '~/components/dealer/DealerDashboard.vue'
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'

const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()

const code = computed(() => String(route.params.code || '').toUpperCase())
const inviteUrl = computed<string>(() => {
  if (!import.meta.client) {
    return `/room/${code.value}/join`
  }

  return `${window.location.origin}/room/${code.value}/join`
})

const { startGame, startHand, finishHand, approveAction, rejectAction, distributePot, undo } = useDealerRoom(code)
useRoomRealtime(code)

const isLoading = ref(false)

onMounted(async () => {
  sessionStore.loadSession()

  const incomingSecret = typeof route.query.dealerSecret === 'string' ? route.query.dealerSecret : null
  if (incomingSecret) {
    sessionStore.saveSession({
      roomCode: code.value,
      playerId: null,
      participantId: null,
      role: 'dealer',
      token: null,
      dealerSecret: incomingSecret
    })
  }

  if (!sessionStore.dealerSecret || sessionStore.roomCode !== code.value) {
    await navigateTo('/')
    return
  }

  const state = await $fetch(`/api/rooms/${code.value}/state`)
  roomStore.setRoomState(state)
})

async function run(action: () => Promise<unknown>) {
  isLoading.value = true
  try {
    await action()
  } catch (error) {
    roomStore.setError(error instanceof Error ? error.message : 'Ошибка выполнения команды')
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <main class="page-shell dealer-room-page">
    <header class="dealer-room-page__head">
      <div>
        <h1 class="page-title">Комната {{ code }}</h1>
        <p class="page-subtitle">Экран дилера. Управление раздачей в реальном времени.</p>
      </div>
      <ConnectionStatus :status="roomStore.connectionStatus" />
    </header>

    <p v-if="roomStore.error" class="dealer-room-page__error">{{ roomStore.error }}</p>

    <section class="dealer-room-page__top">
      <RoomCodeCard :code="code" :invite-url="inviteUrl" />
      <QRCodeInvite :url="inviteUrl" />
      <PlayerLobbyList :players="roomStore.players" />
    </section>

    <DealerDashboard
      :players="roomStore.players"
      :actions="roomStore.actions"
      :pending-actions="roomStore.pendingActions"
      :current-hand="roomStore.currentHand"
      @start-game="run(startGame)"
      @start-hand="run(startHand)"
      @finish-hand="run(finishHand)"
      @undo="run(undo)"
      @approve="run(() => approveAction($event))"
      @reject="run(() => rejectAction($event))"
      @distribute="run(() => distributePot($event))"
    />

    <div class="dealer-room-page__footer">
      <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
      <NuxtLink class="btn btn--ghost" :to="`/room/${code}/table`">Открыть общий стол</NuxtLink>
    </div>

    <p v-if="isLoading" class="page-subtitle">Выполняем команду...</p>
  </main>
</template>

<style scoped lang="scss">
.dealer-room-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__head {
    display: flex;
    justify-content: space-between;
    gap: 0.8rem;
    align-items: flex-start;
  }

  &__top {
    display: grid;
    gap: 0.8rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  &__error {
    margin: 0;
    color: var(--danger);
  }

  &__footer {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
}

@media (max-width: 980px) {
  .dealer-room-page {
    &__top {
      grid-template-columns: 1fr;
    }
  }
}
</style>
