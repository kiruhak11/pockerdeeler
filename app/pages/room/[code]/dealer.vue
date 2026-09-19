<script setup lang="ts">
import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import RoomCodeCard from '~/components/room/RoomCodeCard.vue'
import QRCodeInvite from '~/components/room/QRCodeInvite.vue'
import PlayerLobbyList from '~/components/room/PlayerLobbyList.vue'
import FriendInvitePanel from '~/components/room/FriendInvitePanel.vue'
import RoomChatPanel from '~/components/room/RoomChatPanel.vue'
import DealerDashboard from '~/components/dealer/DealerDashboard.vue'
import DealerRoomSettings from '~/components/dealer/DealerRoomSettings.vue'
import DealerPlayerActionModal from '~/components/dealer/DealerPlayerActionModal.vue'
import DealerPredictionPanel from '~/components/dealer/DealerPredictionPanel.vue'
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { usePredictionStore } from '~/stores/prediction'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { PlayerActionType } from '~/types/game'
import BettingRoundNotice from '~/components/game/BettingRoundNotice.vue'
import PokerHandsGuide from '~/components/game/PokerHandsGuide.vue'

const credentials = useRoomCredentials()
const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()
const predictionStore = usePredictionStore()
const { preferences } = useGamePreferences()

const code = computed(() => String(route.params.code || '').toUpperCase())
const { refreshDealer, decideEntry, decideReentry, voidMarket } = usePredictions(code)
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
  updateSettings,
  deleteRoom
} = useDealerRoom(code)
const { disconnect, reconnect } = useRoomRealtime(code)

const isLoading = ref(false)
const selectedPlayerId = ref<string | null>(null)

const selectedPlayer = computed(() => {
  if (!selectedPlayerId.value) {
    return null
  }

  return roomStore.players.find((player) => player.id === selectedPlayerId.value) ?? null
})

const connectedUserIds = computed(() => [
  ...new Set(
    roomStore.players
      .filter((player) => player.isConnected && player.userId)
      .map((player) => player.userId as string)
  )
])

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

  const state = await $fetch(`/api/rooms/${code.value}/state`, { headers: credentials.headers(code.value) })
  roomStore.setRoomState(state)
  await refreshDealer().catch(() => predictionStore.setDealer(null))
})

async function syncRoomState() {
  const state = await $fetch(`/api/rooms/${code.value}/state`, { headers: credentials.headers(code.value) })
  roomStore.setRoomState(state)
  await refreshDealer().catch(() => undefined)
}

watch(() => roomStore.room?.revision, async (revision) => {
  if (!revision || !sessionStore.dealerSecret) return
  await refreshDealer().catch(() => undefined)
})

async function run(action: () => Promise<unknown>) {
  isLoading.value = true
  try {
    await action()
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Ошибка выполнения команды'))
    // A delayed WebSocket frame can leave the dealer screen behind the server.
    // Refresh the authoritative state after a conflict so showdown/winner controls
    // appear immediately instead of requiring a manual page reload.
    await syncRoomState().catch(() => undefined)
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

async function onUndo() {
  if (confirm('Отменить последнее действие? Если уже есть принятые прогнозы этой раздачи, они будут отменены с возвратом очков.')) await run(undo)
}

async function onDeleteRoom() {
  if (isLoading.value || !confirm('Удалить комнату для всех и выйти? Незавершённая раздача отменится, её взносы вернутся на балансы аккаунтов. Комнату и её историю нельзя будет восстановить.')) return
  isLoading.value = true
  disconnect()
  try {
    await deleteRoom()
    sessionStore.clearSession(); roomStore.resetRoom()
    await navigateTo('/rooms')
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось удалить комнату'))
    reconnect()
  } finally { isLoading.value = false }
}

async function onEntryDecision(memberId: string, decision: 'approve' | 'reject', rebindMemberId?: string) {
  await run(() => decideEntry(memberId, decision, rebindMemberId))
}

async function onReentryDecision(requestId: string, decision: 'approve' | 'reject') {
  await run(() => decideReentry(requestId, decision))
}

async function onMarketVoid(marketId: string, reason: string) {
  await run(() => voidMarket(marketId, reason))
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

    <section class="dealer-room-page__top">
      <FriendInvitePanel :room-code="code" :connected-user-ids="connectedUserIds" />
      <RoomChatPanel :room-code="code" role="dealer" title="Чат лобби" />
    </section>

    <DealerRoomSettings
      :settings="roomStore.room?.settings || null"
      :players-count="roomStore.players.filter(p => p.participantId).length"
      :disabled="isLoading"
      @save="run(() => updateSettings($event))"
    />

    <BettingRoundNotice dealer />

    <TokenPredictions :room-code="code" dealer />

    <DealerPredictionPanel
      :state="predictionStore.dealer"
      :busy="isLoading"
      @decide-entry="onEntryDecision"
      @decide-reentry="onReentryDecision"
      @void-market="onMarketVoid"
    />

    <DealerDashboard
      :busy="isLoading"
      :players="roomStore.players"
      :actions="roomStore.actions"
      :pending-actions="roomStore.pendingActions"
      :current-session="roomStore.currentSession"
      :current-hand="roomStore.currentHand"
      @start-game="run(startGame)"
      @restart-game="run(restartGame)"
      @start-hand="run(startHand)"
      @finish-hand="run(finishHand)"
      @undo="onUndo"
      @approve="run(() => approveAction($event))"
      @reject="run(() => rejectAction($event))"
      @distribute="(ids, pots) => run(() => distributePot(ids, pots))"
      @select-player="selectedPlayerId = $event"
    />

    <div class="dealer-room-page__footer">
      <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
      <NuxtLink class="btn btn--ghost" :to="`/room/${code}/table`">Открыть общий стол</NuxtLink>
      <button class="btn btn--danger" :disabled="isLoading" @click="onDeleteRoom">Удалить комнату и выйти</button>
    </div>

    <p v-if="isLoading" class="page-subtitle">Выполняем команду...</p>
    <PokerHandsGuide v-if="preferences.handsGuide" />

    <DealerPlayerActionModal
      :can-act="selectedPlayer?.id === roomStore.currentSession?.currentPlayerId && !isLoading"
      :visible="Boolean(selectedPlayer)"
      :player-name="selectedPlayer?.name || ''"
      :player-stack="selectedPlayer?.stack || 0"
      :player-status="selectedPlayer?.status"
      :table-rating="selectedPlayer?.tableRating"
      :prediction-rating="selectedPlayer?.predictionRating"
      :achievement-count="selectedPlayer?.achievementCount"
      :achievement-icons="selectedPlayer?.achievementIcons || []"
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
