<script setup lang="ts">
import { useRoomStore } from "~/stores/room"
import { usePlayerSessionStore } from "~/stores/playerSession"
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import PlayerDashboard from '~/components/player/PlayerDashboard.vue'
import HandResultModal from '~/components/player/HandResultModal.vue'
import RoomChatPanel from '~/components/room/RoomChatPanel.vue'
import DailyBonus from '~/components/account/DailyBonus.vue'
import BettingRoundNotice from '~/components/game/BettingRoundNotice.vue'
import PokerHandsGuide from '~/components/game/PokerHandsGuide.vue'
import PredictionDashboard from '~/components/player/PredictionDashboard.vue'
import PlayerTopUpCard from '~/components/player/PlayerTopUpCard.vue'
import { usePredictionStore } from '~/stores/prediction'
import type { BuyInOptionsView } from '~/types/room'

const credentials = useRoomCredentials()
const route = useRoute()
const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()
const accountStore = useAccountStore()
const predictionStore = usePredictionStore()
const { loadMe } = useAccountAuth()
const { preferences } = useGamePreferences()

const code = computed(() => String(route.params.code || '').toUpperCase())
const { refreshViewer, placeBet, requestReentry } = usePredictions(code)
const { sendAction, leaveRoom, getBuyInOptions, topUp, returnStack } = usePlayerRoom(code)
const { disconnect, reconnect } = useRoomRealtime(code)
const leaving = ref(false)
const predictionBusy = ref(false)
const topUpBusy = ref(false)
const buyInOptions = ref<BuyInOptionsView | null>(null)
const { resume } = useReservedRoom()


const waitingApproval = ref(false)
const lastSeenDistributionEventId = ref<string | null>(null)
const stateLoaded = ref(false)
const kickedHandled = ref(false)
const handResultModal = reactive({
  visible: false,
  title: '',
  delta: 0,
  finalStack: 0,
  handNumber: 0,
  predictionGrant: 0,
  predictionBalance: 0
})
let modalTimer: ReturnType<typeof setTimeout> | null = null

const selfPlayer = computed(() => {
  if (!sessionStore.playerId) {
    return null
  }

  return roomStore.players.find((player) => player.id === sessionStore.playerId) ?? null
})
const canReserveSeat = computed(() => Boolean(accountStore.token && selfPlayer.value?.userId && selfPlayer.value.userId === accountStore.user?.id))


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

  try {
    const state = await $fetch(`/api/rooms/${code.value}/state`, { headers: credentials.headers(code.value) })
    roomStore.setRoomState(state)
    if (accountStore.token && roomStore.room?.settings.predictions.enabled) await refreshViewer().catch(() => undefined)
    if (accountStore.token) buyInOptions.value = await getBuyInOptions().catch(() => null)
    if (selfPlayer.value?.isAway && canReserveSeat.value) {
      disconnect()
      await resume(code.value)
      reconnect()
    }
    stateLoaded.value = true
    lastSeenDistributionEventId.value = roomStore.lastDistribution?.eventId ?? null
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось загрузить комнату'))
  }
})

watch(() => roomStore.room?.revision, async revision => {
  if (!stateLoaded.value || !revision || !accountStore.token) return
  if (roomStore.room?.settings.predictions.enabled) await refreshViewer().catch(() => undefined)
  if (accountStore.token) buyInOptions.value = await getBuyInOptions().catch(() => buyInOptions.value)
})

async function onPrediction(candidatePlayerId: string, stake: number, expectedMarketRevision: number) {
  predictionBusy.value = true
  try { await placeBet(candidatePlayerId, stake, expectedMarketRevision) }
  catch (error) { roomStore.setError(getHttpErrorMessage(error, 'Не удалось принять прогноз')); await refreshViewer().catch(() => undefined) }
  finally { predictionBusy.value = false }
}

async function onReentry(amount: number) {
  predictionBusy.value = true
  try { await requestReentry(amount) }
  catch (error) { roomStore.setError(getHttpErrorMessage(error, 'Не удалось запросить возврат')); await refreshViewer().catch(() => undefined) }
  finally { predictionBusy.value = false }
}

async function onTopUp(amount: number) {
  if (!selfPlayer.value?.memberId) return
  topUpBusy.value = true
  try {
    await topUp(selfPlayer.value.memberId, amount)
    await loadMe().catch(() => undefined)
    buyInOptions.value = await getBuyInOptions()
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось пополнить стек'))
    buyInOptions.value = await getBuyInOptions().catch(() => buyInOptions.value)
  } finally {
    topUpBusy.value = false
  }
}

async function onReturnStack(amount: number) {
  if (!selfPlayer.value?.memberId) return
  topUpBusy.value = true
  try {
    await returnStack(selfPlayer.value.memberId, amount)
    await loadMe().catch(() => undefined)
    buyInOptions.value = await getBuyInOptions()
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось вернуть стек на баланс'))
    buyInOptions.value = await getBuyInOptions().catch(() => buyInOptions.value)
  } finally {
    topUpBusy.value = false
  }
}

watch(
  selfPlayer,
  async (player) => {
    if (!stateLoaded.value || kickedHandled.value || leaving.value || !sessionStore.playerId || sessionStore.roomCode !== code.value) {
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
  async ([distribution, player]) => {
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

    if (deltaItem.finalStack === 0 && accountStore.token && roomStore.room?.settings.predictions.enabled) {
      await refreshViewer().catch(() => undefined)
    }

    handResultModal.visible = preferences.handResultModals
    handResultModal.delta = deltaItem.delta
    handResultModal.finalStack = deltaItem.finalStack
    handResultModal.handNumber = distribution.handNumber
    handResultModal.predictionGrant = deltaItem.finalStack === 0 ? (predictionStore.viewer?.grantRemaining || 0) : 0
    handResultModal.predictionBalance = deltaItem.finalStack === 0 ? (predictionStore.viewer?.balance || 0) : 0
    handResultModal.title = handResultModal.predictionGrant > 0
      ? 'Вы выбыли из игры'
      : deltaItem.delta > 0
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

const awayMessage = 'Отойти, сохранив место и стек? До вскрытия карт обычная рука будет сброшена; ва-банк остаётся в игре. Новые раздачи пройдут без вас. Вернуться можно во вкладке «Столы».'
const leaveMessage = 'Выйти полностью и освободить место? Внесённые ставки останутся в банке до расчёта раздачи. Для возвращения потребуется новый вход.'

async function exitRoom(temporary: boolean): Promise<boolean> {
  leaving.value = true
  disconnect()
  try {
    if (temporary) await $fetch(`/api/rooms/${code.value}/away`, { method: 'POST', body: { token: accountStore.token } })
    else { await leaveRoom(); sessionStore.clearSession() }
    roomStore.resetRoom()
    return true
  } catch (error) {
    roomStore.setError(getHttpErrorMessage(error, 'Не удалось выйти. Попробуйте снова.'))
    leaving.value = false; reconnect()
    return false
  }
}
async function onLeave(temporary = false) {
  if (leaving.value || !confirm(temporary ? awayMessage : leaveMessage)) return
  if (await exitRoom(temporary)) await navigateTo('/rooms')
}

onBeforeRouteLeave(async to => {
  if (leaving.value || kickedHandled.value || !stateLoaded.value || !selfPlayer.value?.participantId || to.path.startsWith(`/room/${code.value}/`)) return true
  if (!confirm(canReserveSeat.value ? awayMessage : leaveMessage)) return false
  return exitRoom(canReserveSeat.value)
})
</script>

<template>
  <main class="page-shell player-room-page">
    <header>
      <h1 class="page-title">Игрок · комната {{ code }}</h1>
      <ConnectionStatus :status="roomStore.connectionStatus" />
    </header>

    <p v-if="roomStore.error" class="player-room-page__error">{{ roomStore.error }}</p>

    <BettingRoundNotice />

    <PlayerDashboard
      :self-player="selfPlayer"
      :players="roomStore.players"
      :current-session="roomStore.currentSession"
      :current-hand="roomStore.currentHand"
      :quick-bet-steps="roomStore.room?.settings.quickBetSteps || []"
      :waiting-approval="waitingApproval"
      @action="onAction"
    />

    <PlayerTopUpCard
      v-if="accountStore.token && selfPlayer?.memberId"
      :options="buyInOptions"
      :busy="topUpBusy"
      :hand-active="Boolean(roomStore.currentHand)"
      @top-up="onTopUp"
      @return-stack="onReturnStack"
    />

    <TokenPredictions :room-code="code" />

    <PredictionDashboard
      v-if="predictionStore.viewer?.currentMarket && ['predicting', 'pending_reentry'].includes(predictionStore.viewer.memberState || '')"
      :state="predictionStore.viewer"
      :busy="predictionBusy"
      @bet="onPrediction"
      @reentry="onReentry"
    />

    <RoomChatPanel
      :room-code="code"
      :role="sessionStore.role === 'spectator' ? 'spectator' : 'player'"
      title="Чат комнаты"
    />
    <PokerHandsGuide v-if="preferences.handsGuide" />

    <section v-if="accountStore.user" class="panel player-room-page__profile">
      <h3>Профиль</h3>
      <p>Логин: {{ accountStore.user.username }}</p>
      <p>Свободный кошелёк: {{ accountStore.user.balance }}</p>
      <DailyBonus :in-game="roomStore.room?.status !== 'lobby'" />
    </section>

    <section class="panel player-room-page__exit">
      <h3>Выход из комнаты</h3>
      <p v-if="canReserveSeat" class="page-subtitle">Можно отойти с сохранением места или выйти полностью. Пока место сохранено, баланс участвует в этой игре.</p>
      <button v-if="canReserveSeat" class="btn btn--ghost" :disabled="leaving" @click="onLeave(true)">Отойти, сохранив место</button>
      <button class="btn btn--danger" :disabled="leaving" @click="onLeave(false)">Выйти полностью</button>
    </section>

    <HandResultModal
      :visible="handResultModal.visible"
      :title="handResultModal.title"
      :delta="handResultModal.delta"
      :final-stack="handResultModal.finalStack"
      :hand-number="handResultModal.handNumber"
      :prediction-grant="handResultModal.predictionGrant"
      :prediction-balance="handResultModal.predictionBalance"
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
  &__exit { display: grid; gap: 0.7rem; h3 { margin: 0; } }
}
</style>
