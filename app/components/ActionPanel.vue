<script setup lang="ts">
import type { ActionInput, Player } from '~/types/game'

const props = defineProps<{
  player: Player
  tableCurrentBet: number
  quickRaiseSteps?: number[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  action: [payload: ActionInput]
}>()

const amount = ref<number>(10)

const effectiveQuickSteps = computed(() => {
  const source = props.quickRaiseSteps?.length ? props.quickRaiseSteps : [10, 25, 50, 100]

  return source
    .map((step) => Math.max(1, Math.trunc(step)))
    .slice(0, 6)
})

watch(
  () => [props.tableCurrentBet, props.player.currentBet, props.player.stack, ...effectiveQuickSteps.value],
  () => {
    if (props.tableCurrentBet > 0 && amount.value <= props.tableCurrentBet) {
      amount.value = props.tableCurrentBet + 1
      return
    }

    if (props.tableCurrentBet === 0 && amount.value <= 0) {
      amount.value = effectiveQuickSteps.value[0] ?? 10
    }
  },
  { immediate: true }
)

const isInactive = computed(() => props.player.status === 'folded' || props.player.status === 'out')
const canCheck = computed(() => props.player.currentBet === props.tableCurrentBet && !isInactive.value)
const canCall = computed(
  () => props.tableCurrentBet > props.player.currentBet && props.player.stack > 0 && !isInactive.value
)
const canBet = computed(() => props.tableCurrentBet === 0 && props.player.stack > 0 && !isInactive.value)
const canRaise = computed(() => props.tableCurrentBet > 0 && props.player.stack > 0 && !isInactive.value)
const canAllIn = computed(() => props.player.stack > 0 && !isInactive.value)

function emitAction(type: ActionInput['type'], withAmount = false) {
  if (props.disabled || isInactive.value) {
    return
  }

  emit('action', {
    playerId: props.player.id,
    type,
    amount: withAmount ? Math.trunc(amount.value) : undefined
  })
}

function addQuickAmount(value: number) {
  amount.value = Math.max(0, Math.trunc(amount.value) + value)
}

function setAllInAmount() {
  amount.value = props.player.currentBet + props.player.stack
}

function setToCallAmount() {
  amount.value = props.tableCurrentBet
}
</script>

<template>
  <div class="action-panel">
    <div class="action-panel__amount-row">
      <label class="action-panel__label" :for="`amount-${player.id}`">Сумма</label>
      <input
        :id="`amount-${player.id}`"
        v-model.number="amount"
        type="number"
        min="0"
        class="input"
        :disabled="disabled || isInactive"
      >
    </div>

    <div class="action-panel__quick">
      <button
        v-for="step in effectiveQuickSteps"
        :key="step"
        type="button"
        class="btn btn--ghost"
        :disabled="disabled || isInactive"
        @click="addQuickAmount(step)"
      >
        +{{ step }}
      </button>
      <button type="button" class="btn btn--ghost" :disabled="disabled || isInactive" @click="setToCallAmount">К ставке стола</button>
      <button type="button" class="btn btn--ghost" :disabled="disabled || isInactive" @click="setAllInAmount">До ва-банк</button>
    </div>

    <div class="action-panel__buttons">
      <button type="button" class="btn btn--ghost" :disabled="disabled || !canCheck" @click="emitAction('check')">Чек</button>
      <button type="button" class="btn" :disabled="disabled || !canBet" @click="emitAction('bet', true)">Ставка</button>
      <button type="button" class="btn" :disabled="disabled || !canCall" @click="emitAction('call')">Колл</button>
      <button type="button" class="btn" :disabled="disabled || !canRaise" @click="emitAction('raise', true)">Рейз</button>
      <button type="button" class="btn btn--danger" :disabled="disabled || isInactive" @click="emitAction('fold')">Пас</button>
      <button type="button" class="btn btn--success" :disabled="disabled || !canAllIn" @click="emitAction('all-in')">Ва-банк</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.action-panel {
  display: grid;
  gap: 0.75rem;

  &__label {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  &__amount-row {
    display: grid;
    gap: 0.4rem;
    grid-template-columns: auto 1fr;
    align-items: center;
  }

  &__quick,
  &__buttons {
    display: grid;
    gap: 0.55rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .action-panel {
    &__quick,
    &__buttons {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
}
</style>
