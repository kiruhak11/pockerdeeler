<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from '~/stores/playerSession'

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import GamePotSummary from '~/components/game/PotSummary.vue'
import TablePlayers from '~/components/game/TablePlayers.vue'
import ActionHistory from '~/components/game/ActionHistory.vue'
import RoomChatPanel from '~/components/room/RoomChatPanel.vue'
import BettingRoundNotice from '~/components/game/BettingRoundNotice.vue'
import PokerHandsGuide from '~/components/game/PokerHandsGuide.vue'
import PlayerProfileModal from '~/components/game/PlayerProfileModal.vue'

const credentials = useRoomCredentials()
const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()
const { preferences } = useGamePreferences()

const code = computed(() => String(route.params.code || '').toUpperCase())
useRoomRealtime(code)
const awaitingAdmission = computed(() => route.query.pending === '1'
  && sessionStore.roomCode === code.value
  && sessionStore.role === 'spectator'
  && Boolean(sessionStore.participantId))

const currentPlayer = computed(() => {
  if (!roomStore.currentSession?.currentPlayerId) {
    return null
  }

  return roomStore.players.find((player) => player.id === roomStore.currentSession?.currentPlayerId) ?? null
})
const selectedPlayer = ref<import('~/types/game').Player | null>(null)

onMounted(async () => {
  sessionStore.loadSession()
  const state = await $fetch(`/api/rooms/${code.value}/state`, { headers: credentials.headers(code.value) })
  roomStore.setRoomState(state)
})

watch(
  () => roomStore.players,
  async (players) => {
    if (!awaitingAdmission.value || !sessionStore.participantId) return
    const admitted = players.find(player => player.participantId === sessionStore.participantId)
    if (!admitted) return

    sessionStore.saveSession({
      roomCode: code.value,
      playerId: admitted.id,
      participantId: sessionStore.participantId,
      role: 'player',
      token: sessionStore.token,
      dealerSecret: null
    })
    await navigateTo(`/room/${code.value}/player?playerId=${admitted.id}`)
  },
  { deep: true }
)
</script>

<template>
  <main class="page-shell table-room-page">
    <header>
      <h1 class="page-title">Общий стол · {{ code }}</h1>
      <ConnectionStatus :status="roomStore.connectionStatus" />
    </header>

    <BettingRoundNotice />

    <section v-if="awaitingAdmission" class="panel table-room-page__pending" role="status">
      <strong>Заявка отправлена дилеру</strong>
      <p>Пока можно наблюдать за столом. После подтверждения мы автоматически откроем ваши игровые кнопки.</p>
    </section>

    <GamePotSummary
      :pot="roomStore.currentHand?.pot || 0"
      :current-bet="roomStore.currentHand?.currentBet || 0"
      :hand-number="roomStore.currentHand?.handNumber || 0"
      :small-blind="roomStore.room?.settings.smallBlind"
      :big-blind="roomStore.room?.settings.bigBlind"
      :current-player-name="currentPlayer?.name || null"
    />

    <TablePlayers
      :players="roomStore.players"
      :current-player-id="roomStore.currentSession?.currentPlayerId || null"
      :small-blind-player-id="roomStore.currentSession?.smallBlindPlayerId || null"
      :big-blind-player-id="roomStore.currentSession?.bigBlindPlayerId || null"
      @select-player="selectedPlayer = $event"
    />
    <ActionHistory :actions="roomStore.actions.slice(-15)" />
    <TokenPredictions :room-code="code" />
    <RoomChatPanel :room-code="code" role="viewer" title="Чат комнаты" />
    <PokerHandsGuide v-if="preferences.handsGuide" />
    <PlayerProfileModal :player="selectedPlayer" @close="selectedPlayer = null" />
  </main>
</template>

<style scoped lang="scss">
.table-room-page {
  display: grid;
  gap: 0.85rem;
  padding-block: 1rem 2rem;

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
  }

  &__pending {
    display: grid;
    gap: 0.35rem;
    border-color: rgba(240, 188, 79, 0.32);

    p {
      margin: 0;
      color: var(--text-muted);
    }
  }
}
</style>
