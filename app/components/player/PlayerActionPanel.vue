<script setup lang="ts">
import type { AvailableActions, PlayerActionType } from '~/types/game'

const props = defineProps<{
  waitingApproval?: boolean
  availability: AvailableActions
  pot: number
  stack: number
}>()

const emit = defineEmits<{
  action: [payload: { type: PlayerActionType; amount: number }]
}>()

const amount = ref(0)

const controlsDisabled = computed(() => Boolean(props.waitingApproval))
const anyActionAvailable = computed(() =>
  props.availability.canCheck
  || props.availability.canCall
  || props.availability.canBet
  || props.availability.canRaise
  || props.availability.canFold
  || props.availability.canAllIn
)

const disabledReason = computed(() => {
  if (props.waitingApproval) {
    return 'Ожидаем подтверждения дилера'
  }

  if (!anyActionAvailable.value) {
    return props.availability.disabledReason || 'Действия временно недоступны'
  }

  return ''
})

function normalizeInputAmount(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0
  }

  return Math.max(0, Math.trunc(raw))
}

function send(type: PlayerActionType) {
  if (controlsDisabled.value) {
    return
  }

  emit('action', {
    type,
    amount: normalizeInputAmount(amount.value || 0)
  })
}

function setMinAmount() {
  if (props.availability.canRaise) {
    amount.value = props.availability.minRaiseAmount
    return
  }

  if (props.availability.canBet) {
    amount.value = 1
    return
  }

  amount.value = props.availability.callAmount || 1
}

function setHalfPot() {
  amount.value = Math.max(1, Math.floor(props.pot / 2))
}

function setPot() {
  amount.value = Math.max(1, props.pot)
}
</script>

<template>
  <section class="panel player-action-panel">
    <p v-if="waitingApproval" class="waiting">Ожидаем подтверждения дилера...</p>
    <p v-else-if="disabledReason" class="waiting">{{ disabledReason }}</p>

    <label>
      <span>Сумма</span>
      <input
        v-model.number="amount"
        class="input"
        type="number"
        min="0"
        :max="stack"
        :disabled="controlsDisabled"
      >
    </label>

    <div class="player-action-panel__quick">
      <button type="button" class="btn btn--ghost" :disabled="controlsDisabled" @click="setMinAmount">Мин</button>
      <button type="button" class="btn btn--ghost" :disabled="controlsDisabled" @click="setHalfPot">1/2 банка</button>
      <button type="button" class="btn btn--ghost" :disabled="controlsDisabled" @click="setPot">Банк</button>
      <button type="button" class="btn btn--ghost" :disabled="controlsDisabled || !availability.canAllIn" @click="send('all-in')">Ва-банк</button>
    </div>

    <div class="player-action-panel__grid">
      <button type="button" class="btn" :disabled="controlsDisabled || !availability.canCheck" @click="send('check')">Чек</button>
      <button type="button" class="btn" :disabled="controlsDisabled || !availability.canCall" @click="send('call')">
        Колл {{ availability.callAmount > 0 ? `(${availability.callAmount})` : '' }}
      </button>
      <button type="button" class="btn" :disabled="controlsDisabled || !availability.canBet" @click="send('bet')">Ставка</button>
      <button type="button" class="btn" :disabled="controlsDisabled || !availability.canRaise" @click="send('raise')">
        Рейз от {{ availability.minRaiseAmount }}
      </button>
      <button type="button" class="btn btn--danger" :disabled="controlsDisabled || !availability.canFold" @click="send('fold')">Пас</button>
      <button type="button" class="btn btn--success" :disabled="controlsDisabled || !availability.canAllIn" @click="send('all-in')">Ва-банк</button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.player-action-panel {
  display: grid;
  gap: 0.7rem;

  label {
    display: grid;
    gap: 0.35rem;

    span {
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
  }

  &__grid,
  &__quick {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.waiting {
  margin: 0;
  color: var(--accent-strong);
}
</style>
