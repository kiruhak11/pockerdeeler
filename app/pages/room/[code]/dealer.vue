<script setup lang="ts">
import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import RoomCodeCard from '~/components/room/RoomCodeCard.vue'
import QRCodeInvite from '~/components/room/QRCodeInvite.vue'
import PlayerLobbyList from '~/components/room/PlayerLobbyList.vue'
import DealerDashboard from '~/components/dealer/DealerDashboard.vue'
import DealerRoomSettings from '~/components/dealer/DealerRoomSettings.vue'
import DealerPlayerActionModal from '~/components/dealer/DealerPlayerActionModal.vue'
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { PlayerActionType } from '~/types/game'

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

const {
  startGame,
  restartGame,
  startHand,
  finishHand,
  approveAction,
  rejectAction,
  distributePot,
  undo,
  forceAction,
  kickPlayer,
  updateSettings
} = useDealerRoom(code)
useRoomRealtime(code)

const isLoading = ref(false)
const selectedPlayerId = ref<string | null>(null)

const selectedPlayer = computed(() => {
  if (!selectedPlayerId.value) {
    return null
  }

  return roomStore.players.find((player) => player.id === selectedPlayerId.value) ?? null
})

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
    roomStore.setError(getHttpErrorMessage(error, 'Ошибка выполнения команды'))
  } finally {
    isLoading.value = false
  }
}

async function onForceAction(payload: { type: PlayerActionType; amount: number }) {
  if (!selectedPlayer.value) {
    return
  }

  await run(() => forceAction({
    playerId: selectedPlayer.value!.id,
    type: payload.type,
    amount: payload.amount
  }))
  selectedPlayerId.value = null
}

async function onKickPlayer() {
  if (!selectedPlayer.value) {
    return
  }

  if (!confirm(`Выгнать игрока ${selectedPlayer.value.name} из комнаты?`)) {
    return
  }

  await run(() => kickPlayer(selectedPlayer.value!.id))
  selectedPlayerId.value = null
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

    <DealerRoomSettings
      :settings="roomStore.room?.settings || null"
      :players-count="roomStore.players.length"
      :disabled="isLoading"
      @save="run(() => updateSettings($event))"
    />

    <DealerDashboard
      :players="roomStore.players"
      :actions="roomStore.actions"
      :pending-actions="roomStore.pendingActions"
      :current-session="roomStore.currentSession"
      :current-hand="roomStore.currentHand"
      @start-game="run(startGame)"
      @restart-game="run(restartGame)"
      @start-hand="run(startHand)"
      @finish-hand="run(finishHand)"
      @undo="run(undo)"
      @approve="run(() => approveAction($event))"
      @reject="run(() => rejectAction($event))"
      @distribute="run(() => distributePot($event))"
      @select-player="selectedPlayerId = $event"
    />

    <div class="dealer-room-page__footer">
      <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
      <NuxtLink class="btn btn--ghost" :to="`/room/${code}/table`">Открыть общий стол</NuxtLink>
    </div>

    <p v-if="isLoading" class="page-subtitle">Выполняем команду...</p>

    <DealerPlayerActionModal
      :visible="Boolean(selectedPlayer)"
      :player-name="selectedPlayer?.name || ''"
      :player-stack="selectedPlayer?.stack || 0"
      @close="selectedPlayerId = null"
      @force-action="onForceAction"
      @kick="onKickPlayer"
    />
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
