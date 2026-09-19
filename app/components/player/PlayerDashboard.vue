<script setup lang="ts">
import type { AvailableActions, OnlineGameSession, OnlineHand, Player } from '~/types/game'
import { getAvailableActions } from '~/utils/pokerCalculations'
import PlayerStackCard from './PlayerStackCard.vue'
import PlayerActionPanel from './PlayerActionPanel.vue'
import PlayerTableView from './PlayerTableView.vue'
import { useRoomStore } from '~/stores/room'

const roomStore = useRoomStore()
const profilePlayer = ref<Player | null>(null)

const props = defineProps<{
  selfPlayer: Player | null
  players: Player[]
  currentSession: OnlineGameSession | null
  currentHand: OnlineHand | null
  quickBetSteps: number[]
  waitingApproval: boolean
}>()

const emit = defineEmits<{
  action: [payload: { type: 'check' | 'bet' | 'call' | 'raise' | 'fold' | 'all-in'; amount: number }]
}>()

const currentPlayer = computed(() => {
  if (!props.currentSession?.currentPlayerId) {
    return null
  }

  return props.players.find((player) => player.id === props.currentSession?.currentPlayerId) ?? null
})

const isMyTurn = computed(() => {
  if (!props.selfPlayer || !props.currentSession?.currentPlayerId) {
    return false
  }

  return props.currentSession.currentPlayerId === props.selfPlayer.id
})

const availability = computed<AvailableActions>(() => {
  if (!props.selfPlayer) {
    return {
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      canAllIn: false,
      callAmount: 0,
      minRaiseAmount: 1,
      disabledReason: 'Игрок не найден'
    }
  }

  return getAvailableActions(props.selfPlayer, {
    currentBet: props.currentHand?.currentBet ?? 0,
    handActive: props.currentHand?.status === 'active',
    bettingState: props.currentHand?.bettingState,
    isCurrentPlayer: isMyTurn.value
  })
})

const blockedReason = computed(() => !roomStore.isStateFresh ? 'Восстанавливаем связь. Показано последнее известное состояние.'
  : roomStore.uncertainAction ? 'Проверяем результат предыдущей ставки. Новую пока не отправляем.'
  : !props.currentHand ? 'Ждём начала раздачи от дилера.' : '')
const waitingForDealer = computed(() => props.waitingApproval || roomStore.pendingActions.some(action => action.playerId === props.selfPlayer?.id))
const showHelp = ref(false)
const helpStep = ref(0)
const tutorialKey = 'poker-player-tutorial-v1'
const helpSteps = [
  'Играем настоящими картами за одним столом. Сайт заменяет фишки и считает банк; карты здесь не раздаются.',
  'Дождитесь надписи «Ваш ход». Стек — ваши фишки, банк — все внесённые ставки. Блайнды — обязательные ставки в начале раздачи.',
  'Уравнять (колл) — доплатить до ставки стола. Повысить (рейз) — увеличить итоговую ставку. Перед отправкой видно точное списание. Ва-банк — весь оставшийся стек.',
  'Победителя указывает дилер. Побочный банк учитывает разные размеры ва-банка. Прогнозы выбывших — отдельный режим, не ставки за столом.'
]
function finishHelp() {
  showHelp.value = false
  try { localStorage.setItem(tutorialKey, 'complete') } catch { /* Help remains available without storage. */ }
}
onMounted(() => {
  try { showHelp.value = localStorage.getItem(tutorialKey) !== 'complete' } catch { showHelp.value = true }
})
</script>

<template>
  <section class="player-dashboard">
    <p v-if="!roomStore.isStateFresh" role="status">Показано последнее известное состояние. Обновляем игру…</p>
    <p v-if="roomStore.recoveryMessage" role="status">{{ roomStore.recoveryMessage }}</p>
    <button v-if="roomStore.uncertainAction" type="button" class="btn btn--ghost" :disabled="!roomStore.isStateFresh || roomStore.actionBusy" @click="roomStore.retryActionRequest++">Проверить действие</button>
    <button v-if="roomStore.uncertainAction && !roomStore.actionBusy && roomStore.isStateFresh && roomStore.room?.revision === roomStore.uncertainAction.expectedRevision" type="button" class="btn btn--ghost" @click="roomStore.retryActionDeliveryRequest++">Повторить исходный запрос ставки (не новую ставку)</button>
    <PlayerStackCard
      :player="selfPlayer"
      :pot="currentHand?.pot || 0"
      :current-bet="currentHand?.currentBet || 0"
      :call-amount="availability.callAmount"
      :is-my-turn="isMyTurn && roomStore.isStateFresh"
      :current-player-name="currentPlayer?.name || null"
    />

    <PlayerActionPanel
      v-if="selfPlayer && selfPlayer.status !== 'out'"
      :waiting-approval="waitingForDealer"
      :busy="roomStore.actionBusy"
      :blocked-reason="blockedReason"
      :context-key="`${currentHand?.id}:${roomStore.room?.revision}`"
      :availability="availability"
      :quick-bet-steps="quickBetSteps"
      :stack="selfPlayer?.stack || 0"
      :current-player-bet="selfPlayer?.currentBet || 0"
      @action="emit('action', $event)"
    />

    <button class="btn btn--ghost" type="button" :disabled="isMyTurn && roomStore.isStateFresh" @click="showHelp = !showHelp; helpStep = 0">Как играть</button>
    <section v-if="showHelp && !(isMyTurn && roomStore.isStateFresh)" class="panel player-help" aria-label="Как играть">
      <h3>Как играть · {{ helpStep + 1 }} / {{ helpSteps.length }}</h3>
      <p>{{ helpSteps[helpStep] }}</p>
      <button v-if="helpStep < helpSteps.length - 1" class="btn" type="button" @click="helpStep++">Далее</button>
      <button v-else class="btn" type="button" @click="finishHelp">Понятно</button>
      <button class="btn btn--ghost" type="button" @click="finishHelp">Пропустить</button>
    </section>

    <PlayerTableView
      :players="players"
      :self-player-id="selfPlayer?.id || null"
      :current-player-id="currentSession?.currentPlayerId || null"
      :small-blind-player-id="currentSession?.smallBlindPlayerId || null"
      :big-blind-player-id="currentSession?.bigBlindPlayerId || null"
      @select-player="profilePlayer = $event"
    />
    <PlayerProfileModal :player="profilePlayer" @close="profilePlayer = null" />
  </section>
</template>

<style scoped lang="scss">
.player-dashboard {
  display: grid;
  gap: 0.8rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.player-help { display: grid; gap: 0.6rem; h3, p { margin: 0; } }
</style>
