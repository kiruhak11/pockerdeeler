<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import PlayerDashboard from '~/components/player/PlayerDashboard.vue'

const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()

const code = computed(() => String(route.params.code || '').toUpperCase())
const { sendAction } = usePlayerRoom(code)

useRoomRealtime(code)

const waitingApproval = ref(false)

const selfPlayer = computed(() => {
  if (!sessionStore.playerId) {
    return null
  }

  return roomStore.players.find((player) => player.id === sessionStore.playerId) ?? null
})

onMounted(async () => {
  sessionStore.loadSession()
  if (sessionStore.role !== 'player' || sessionStore.roomCode !== code.value || !sessionStore.playerId) {
    await navigateTo(`/room/${code.value}/join`)
    return
  }

  const state = await $fetch(`/api/rooms/${code.value}/state`)
  roomStore.setRoomState(state)
})

async function onAction(payload: { type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'; amount: number }) {
  waitingApproval.value = true
  try {
    const result = await sendAction(payload) as { action?: { status: string } }
    waitingApproval.value = result.action?.status === 'pending'
  } catch (error) {
    waitingApproval.value = false
    roomStore.setError(error instanceof Error ? error.message : 'Ошибка отправки действия')
  }
}
</script>

<template>
  <main class="page-shell player-room-page">
    <header>
      <h1 class="page-title">Игрок · комната {{ code }}</h1>
      <ConnectionStatus :status="roomStore.connectionStatus" />
    </header>

    <p v-if="roomStore.error" class="player-room-page__error">{{ roomStore.error }}</p>

    <PlayerDashboard
      :self-player="selfPlayer"
      :players="roomStore.players"
      :current-hand="roomStore.currentHand"
      :waiting-approval="waitingApproval"
      @action="onAction"
    />

    <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
  </main>
</template>

<style scoped lang="scss">
.player-room-page {
  display: grid;
  gap: 0.85rem;
  padding-block: 1rem 2rem;

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
  }

  &__error {
    margin: 0;
    color: var(--danger);
  }
}
</style>
