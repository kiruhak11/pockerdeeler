<script setup lang="ts">
import type { AvailableActions, PlayerActionType } from '~/types/game'

const props = defineProps<{
  waitingApproval?: boolean
  busy?: boolean
  blockedReason?: string
  contextKey?: string
  availability: AvailableActions
  quickBetSteps: number[]
  stack: number
  currentPlayerBet?: number
}>()
const emit = defineEmits<{ action: [payload: { type: PlayerActionType; amount: number }] }>()
const { preferences } = useGamePreferences()
const actionLabels = computed(() => preferences.actionLanguage === 'ru'
  ? { check: 'Чек', call: 'Поддержать', bet: 'Поставить', raise: 'Повысить от', fold: 'Сбросить', allIn: 'Ва-банк', yes: 'Да, ва-банк', cancel: 'Отмена' }
  : { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise from', fold: 'Fold', allIn: 'All-in', yes: 'Yes, All-in', cancel: 'Cancel' })
const amount = ref(0)
const confirmingAllIn = ref(false)
const submitted = ref(false)
const actionPanel = ref<HTMLElement | null>(null)
const currentBet = computed(() => props.currentPlayerBet || 0)
const maxTotal = computed(() => props.stack + currentBet.value)
const minTotal = computed(() => props.availability.minRaiseAmount)
const debit = computed(() => Math.max(0, amount.value - currentBet.value))
const anyActionAvailable = computed(() => props.availability.canCheck || props.availability.canCall || props.availability.canBet
  || props.availability.canRaise || props.availability.canFold || props.availability.canAllIn)
const disabledReason = computed(() => props.blockedReason || (props.busy ? 'Отправляем действие…' : '')
  || (props.waitingApproval ? 'Ожидаем подтверждения дилера' : '')
  || (!anyActionAvailable.value ? props.availability.disabledReason || 'Действия временно недоступны' : ''))
const controlsDisabled = computed(() => Boolean(disabledReason.value) || submitted.value)
const canSetTotal = computed(() => (props.availability.canBet || props.availability.canRaise) && maxTotal.value >= minTotal.value)
const validAmount = computed(() => Number.isSafeInteger(amount.value) && amount.value >= minTotal.value && amount.value <= maxTotal.value)
const quickButtons = computed(() => [...new Set([100, 200, ...props.quickBetSteps.map(step => Math.trunc(step)).filter(step => step > 0)])].slice(0, 10))

function scrollToActionPanel() {
  if (!preferences.turnAutoScroll) return
  void nextTick(() => actionPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

function notifyTurn() {
  if (preferences.turnVibration && import.meta.client && 'vibrate' in navigator) {
    navigator.vibrate([140, 80, 140])
  }
}

watch(() => [props.contextKey, props.busy, props.waitingApproval, props.blockedReason, props.stack, props.currentPlayerBet], () => {
  submitted.value = false
  confirmingAllIn.value = false
})
watch(() => [props.contextKey, minTotal.value], () => { amount.value = minTotal.value }, { immediate: true })
watch(
  () => anyActionAvailable.value,
  (enabled, wasEnabled) => {
    if (enabled && !wasEnabled) {
      notifyTurn()
      scrollToActionPanel()
    }
  },
  { flush: 'post' }
)
onMounted(() => { if (anyActionAvailable.value) scrollToActionPanel() })

function send(type: PlayerActionType, confirmed = false) {
  if (controlsDisabled.value) return
  const allowed = { check: props.availability.canCheck, call: props.availability.canCall, bet: props.availability.canBet,
    raise: props.availability.canRaise, fold: props.availability.canFold, 'all-in': props.availability.canAllIn }
  if (!allowed[type] || ((type === 'bet' || type === 'raise') && !validAmount.value)) return
  const usesWholeStack = type === 'all-in' || (type === 'call' && props.availability.callAmount >= props.stack)
    || ((type === 'bet' || type === 'raise') && debit.value === props.stack)
  if (usesWholeStack && !confirmed) { confirmingAllIn.value = true; return }
  confirmingAllIn.value = false
  submitted.value = true
  emit('action', { type, amount: type === 'raise' || type === 'bet' ? amount.value : 0 })
  void nextTick(() => { submitted.value = false })
}
</script>

<template>
  <section ref="actionPanel" class="panel player-action-panel" :aria-busy="busy">
    <p v-if="disabledReason" class="waiting" role="status">{{ disabledReason }}</p>
    <template v-if="canSetTotal">
      <label>
        <span>Итоговая ставка за этот круг</span>
        <input v-model.number="amount" class="input" type="number" inputmode="numeric" step="1"
          :min="minTotal" :max="maxTotal" :disabled="controlsDisabled" aria-describedby="bet-debit">
      </label>
      <p id="bet-debit">Ставка станет {{ amount || 0 }}. Из стека спишется {{ debit }}.</p>
      <p v-if="!validAmount" class="waiting">Укажите целое число от {{ minTotal }} до {{ maxTotal }}. Для неполной ставки есть «Ва-банк».</p>
      <div class="player-action-panel__quick">
        <button type="button" class="btn btn--ghost" :disabled="controlsDisabled" @click="amount = minTotal">До минимума · {{ minTotal }}</button>
        <button v-for="step in quickButtons" :key="step" type="button" class="btn btn--ghost"
          :disabled="controlsDisabled || amount + step > maxTotal" @click="amount = Math.min(maxTotal, amount + step)">+{{ step }}</button>
      </div>
    </template>
    <div v-if="!confirmingAllIn" class="player-action-panel__grid">
      <button v-if="availability.canCheck" type="button" class="btn" :disabled="controlsDisabled" @click="send('check')">{{ actionLabels.check }}</button>
      <button v-if="availability.canCall" type="button" class="btn" :disabled="controlsDisabled" @click="send('call')">{{ actionLabels.call }} · {{ Math.min(stack, availability.callAmount) }}</button>
      <button v-if="availability.canBet && canSetTotal" type="button" class="btn" :disabled="controlsDisabled || !validAmount" @click="send('bet')">{{ actionLabels.bet }} · {{ amount || 0 }}</button>
      <button v-if="availability.canRaise && canSetTotal" type="button" class="btn" :disabled="controlsDisabled || !validAmount" @click="send('raise')">{{ actionLabels.raise }} · {{ amount || 0 }}</button>
      <button v-if="availability.canFold" type="button" class="btn btn--danger" :disabled="controlsDisabled" @click="send('fold')">{{ actionLabels.fold }}</button>
      <button v-if="availability.canAllIn" type="button" class="btn btn--success" :disabled="controlsDisabled" @click="send('all-in')">{{ actionLabels.allIn }} · {{ stack }}</button>
    </div>
    <section v-else class="all-in-confirmation" role="group" aria-label="Подтверждение ва-банка">
      <p>Поставить весь стек: {{ stack }}? Ваша ставка за круг станет {{ maxTotal }}. Эти фишки могут быть проиграны.</p>
      <button class="btn btn--danger" type="button" :disabled="controlsDisabled || !availability.canAllIn" @click="send('all-in', true)">{{ actionLabels.yes }} · {{ stack }}</button>
      <button class="btn btn--ghost" type="button" @click="confirmingAllIn = false">{{ actionLabels.cancel }}</button>
    </section>
  </section>
</template>

<style scoped lang="scss">
.player-action-panel {
  display: grid; gap: 0.7rem; min-width: 0; padding-bottom: max(1rem, env(safe-area-inset-bottom));
  label { display: grid; gap: 0.35rem; span { color: var(--text-muted); font-size: var(--text-sm); } }
  input { min-width: 0; width: 100%; scroll-margin-bottom: 8rem; }
  p { margin: 0; overflow-wrap: anywhere; }
  button { min-height: 48px; white-space: normal; overflow-wrap: anywhere; }
  &__grid { display: grid; gap: 0.5rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  &__quick { display: flex; gap: 0.5rem; flex-wrap: wrap; }
}
.waiting { color: var(--accent-strong); }
.all-in-confirmation { display: grid; gap: 0.6rem; }
</style>
