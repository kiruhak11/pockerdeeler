<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import PlayerDashboard from '~/components/player/PlayerDashboard.vue'
import HandResultModal from '~/components/player/HandResultModal.vue'

const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()
const accountStore = useAccountStore()
const { loadMe, resetBalance } = useAccountAuth()

const code = computed(() => String(route.params.code || '').toUpperCase())
const { sendAction } = usePlayerRoom(code)

useRoomRealtime(code)

const waitingApproval = ref(false)
const lastSeenDistributionEventId = ref<string | null>(null)
const stateLoaded = ref(false)
const kickedHandled = ref(false)
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

const canResetBalance = computed(() => {
  return Boolean(
    accountStore.token
    && accountStore.user
    && accountStore.user.balance < 5000
    && selfPlayer.value
    && roomStore.room?.status === 'lobby'
  )
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
  accountStore.loadSession()
  if (accountStore.token) {
    await loadMe().catch(() => accountStore.clearSession())
  }

  sessionStore.loadSession()
  if (sessionStore.role !== 'player' || sessionStore.roomCode !== code.value || !sessionStore.playerId) {
    await navigateTo(`/room/${code.value}/join`)
    return
  }

  const state = await $fetch(`/api/rooms/${code.value}/state`)
  roomStore.setRoomState(state)
  stateLoaded.value = true
  lastSeenDistributionEventId.value = roomStore.lastDistribution?.eventId ?? null
})

watch(
  selfPlayer,
  async (player) => {
    if (!stateLoaded.value || kickedHandled.value) {
      return
    }

    if (!player || player.isConnected === false || !player.participantId) {
      kickedHandled.value = true
      waitingApproval.value = false
      roomStore.setError('Вас удалили из комнаты')
      sessionStore.clearSession()
      await navigateTo(`/room/${code.value}/join?reason=kicked`)
    }
  },
  { deep: true }
)

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

    if (accountStore.token) {
      loadMe().catch(() => undefined)
    }
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

async function onResetBalance() {
  if (!canResetBalance.value || !selfPlayer.value) {
    return
  }

  try {
    await resetBalance({
      roomCode: code.value,
      playerId: selfPlayer.value.id
    })
    const state = await $fetch(`/api/rooms/${code.value}/state`)
    roomStore.setRoomState(state)
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось обновить баланс'))
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

    <section v-if="accountStore.user" class="panel player-room-page__profile">
      <h3>Профиль</h3>
      <p>Логин: {{ accountStore.user.username }}</p>
      <p>Баланс аккаунта: {{ accountStore.user.balance }}</p>
      <button
        type="button"
        class="btn btn--ghost"
        :disabled="!canResetBalance"
        @click="onResetBalance"
      >
        Обновить баланс до 5000
      </button>
      <p class="page-subtitle">Кнопка доступна только в лобби и если баланс аккаунта меньше 5000.</p>
    </section>

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

  &__profile {
    display: grid;
    gap: 0.4rem;

    h3,
    p {
      margin: 0;
    }
  }
}
</style>
