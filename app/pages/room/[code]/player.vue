<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"
import { getHttpErrorMessage } from '~/utils/httpError'

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import PlayerDashboard from '~/components/player/PlayerDashboard.vue'
import HandResultModal from '~/components/player/HandResultModal.vue'

const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()

const code = computed(() => String(route.params.code || '').toUpperCase())
const { sendAction } = usePlayerRoom(code)

useRoomRealtime(code)

const waitingApproval = ref(false)
const lastSeenDistributionEventId = ref<string | null>(null)
const handResultModal = reactive({
  visible: false,
  title: '',
  delta: 0,
  finalStack: 0,
  handNumber: 0
})
let modalTimer: ReturnType<typeof setTimeout> | null = null

const selfPlayer = computed(() => {
  if (!sessionStore.playerId) {
    return null
  }

  return roomStore.players.find((player) => player.id === sessionStore.playerId) ?? null
})

watch(
  () => roomStore.pendingActions,
  (pendingActions) => {
    if (!sessionStore.playerId) {
      waitingApproval.value = false
      return
    }

    waitingApproval.value = pendingActions.some((action) => action.playerId === sessionStore.playerId)
  },
  { deep: true }
)

onBeforeUnmount(() => {
  if (modalTimer) {
    clearTimeout(modalTimer)
    modalTimer = null
  }
})

onMounted(async () => {
  sessionStore.loadSession()
  if (sessionStore.role !== 'player' || sessionStore.roomCode !== code.value || !sessionStore.playerId) {
    await navigateTo(`/room/${code.value}/join`)
    return
  }

  const state = await $fetch(`/api/rooms/${code.value}/state`)
  roomStore.setRoomState(state)
  lastSeenDistributionEventId.value = roomStore.lastDistribution?.eventId ?? null
})

watch(
  [() => roomStore.lastDistribution, selfPlayer],
  ([distribution, player]) => {
    if (!distribution || !player) {
      return
    }

    if (distribution.eventId === lastSeenDistributionEventId.value) {
      return
    }

    const deltaItem = distribution.deltas.find((item) => item.playerId === player.id)
    if (!deltaItem) {
      lastSeenDistributionEventId.value = distribution.eventId
      return
    }

    handResultModal.visible = true
    handResultModal.delta = deltaItem.delta
    handResultModal.finalStack = deltaItem.finalStack
    handResultModal.handNumber = distribution.handNumber
    handResultModal.title = deltaItem.delta > 0
      ? 'Победа в раздаче'
      : deltaItem.delta < 0
        ? 'Поражение в раздаче'
        : 'Раздача завершена'

    lastSeenDistributionEventId.value = distribution.eventId

    if (modalTimer) {
      clearTimeout(modalTimer)
    }

    modalTimer = setTimeout(() => {
      handResultModal.visible = false
    }, 3000)
  },
  { deep: true }
)

async function onAction(payload: { type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'; amount: number }) {
  waitingApproval.value = true
  try {
    const result = await sendAction(payload) as { action?: { status: string } }
    waitingApproval.value = result.action?.status === 'pending'
  } catch (error) {
    waitingApproval.value = false
    roomStore.setError(getHttpErrorMessage(error, 'Ошибка отправки действия'))
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
      :current-session="roomStore.currentSession"
      :current-hand="roomStore.currentHand"
      :quick-bet-steps="roomStore.room?.settings.quickBetSteps || []"
      :waiting-approval="waitingApproval"
      @action="onAction"
    />

    <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>

    <HandResultModal
      :visible="handResultModal.visible"
      :title="handResultModal.title"
      :delta="handResultModal.delta"
      :final-stack="handResultModal.finalStack"
      :hand-number="handResultModal.handNumber"
    />
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
