<script setup lang="ts">
import type { PlayerActionType } from '~/types/game'

const props = defineProps<{
  disabled?: boolean
  waitingApproval?: boolean
}>()

const emit = defineEmits<{
  action: [payload: { type: PlayerActionType; amount: number }]
}>()

const amount = ref(0)

function send(type: PlayerActionType) {
  emit('action', {
    type,
    amount: Math.max(0, Math.trunc(amount.value || 0))
  })
}
</script>

<template>
  <section class="panel player-action-panel">
    <p v-if="waitingApproval" class="waiting">Ожидаем подтверждения дилера...</p>

    <label>
      <span>Сумма</span>
      <input v-model.number="amount" class="input" type="number" min="0" :disabled="disabled || waitingApproval">
    </label>

    <div class="player-action-panel__quick">
      <button type="button" class="btn btn--ghost" :disabled="disabled || waitingApproval" @click="amount = 1">Мин</button>
      <button type="button" class="btn btn--ghost" :disabled="disabled || waitingApproval" @click="amount = Math.floor((amount || 0) / 2)">1/2 банка</button>
      <button type="button" class="btn btn--ghost" :disabled="disabled || waitingApproval" @click="amount = Math.max(amount, 100)">Банк</button>
      <button type="button" class="btn btn--ghost" :disabled="disabled || waitingApproval" @click="send('all-in')">Ва-банк</button>
    </div>

    <div class="player-action-panel__grid">
      <button type="button" class="btn" :disabled="disabled || waitingApproval" @click="send('check')">Чек</button>
      <button type="button" class="btn" :disabled="disabled || waitingApproval" @click="send('call')">Колл</button>
      <button type="button" class="btn" :disabled="disabled || waitingApproval" @click="send('bet')">Ставка</button>
      <button type="button" class="btn" :disabled="disabled || waitingApproval" @click="send('raise')">Рейз</button>
      <button type="button" class="btn btn--danger" :disabled="disabled || waitingApproval" @click="send('fold')">Пас</button>
      <button type="button" class="btn btn--success" :disabled="disabled || waitingApproval" @click="send('all-in')">Ва-банк</button>
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
