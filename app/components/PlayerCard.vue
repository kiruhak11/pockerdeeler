<script setup lang="ts">
import type { ActionInput, Player } from '~/types/game'

const props = defineProps<{
  player: Player
  tableCurrentBet: number
  quickRaiseSteps?: number[]
  actionsDisabled?: boolean
}>()

const emit = defineEmits<{
  action: [payload: ActionInput]
}>()

const statusLabelMap: Record<Player['status'], string> = {
  waiting: 'Ожидает',
  active: 'Активен',
  checked: 'Чек',
  folded: 'Пас',
  'all-in': 'Ва-банк',
  winner: 'Победитель',
  out: 'Выбыл'
}

function forwardAction(payload: ActionInput) {
  emit('action', payload)
}
</script>

<template>
  <article class="player-card" :class="`player-card--${player.status}`">
    <header class="player-card__header">
      <div>
        <h3 class="player-card__name">{{ player.name }}</h3>
        <p v-if="player.seat" class="player-card__seat">Место: {{ player.seat }}</p>
      </div>
      <span class="tag player-card__status">{{ statusLabelMap[player.status] }}</span>
    </header>

    <dl class="player-card__metrics">
      <div>
        <dt>Стек</dt>
        <dd>{{ player.stack }}</dd>
      </div>
      <div>
        <dt>Ставка</dt>
        <dd>{{ player.currentBet }}</dd>
      </div>
      <div>
        <dt>Вложено</dt>
        <dd>{{ player.totalCommitted }}</dd>
      </div>
    </dl>

    <ActionPanel
      :player="player"
      :table-current-bet="tableCurrentBet"
      :quick-raise-steps="quickRaiseSteps"
      :disabled="actionsDisabled"
      @action="forwardAction"
    />
  </article>
</template>

<style scoped lang="scss">
.player-card {
  display: grid;
  gap: 0.9rem;
  padding: 0.9rem;
  border-radius: var(--radius-lg);
  background: linear-gradient(160deg, rgba(23, 35, 31, 0.95), rgba(18, 30, 26, 0.95));
  border: 1px solid rgba(255, 255, 255, 0.12);

  &__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.7rem;
  }

  &__name {
    margin: 0;
    font-size: 1.15rem;
  }

  &__seat {
    margin: 0.2rem 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  &__metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.65rem;
    margin: 0;

    div {
      background: rgba(255, 255, 255, 0.05);
      border-radius: var(--radius-sm);
      padding: 0.45rem;
    }

    dt {
      color: var(--text-muted);
      font-size: var(--text-xs);
    }

    dd {
      margin: 0.2rem 0 0;
      font-size: 1.07rem;
      font-weight: 600;
    }
  }

  &--folded {
    opacity: 0.5;
    filter: grayscale(0.25);
  }

  &--all-in {
    border-color: rgba(242, 180, 81, 0.7);
  }

  &--winner {
    border-color: rgba(90, 196, 130, 0.75);
    box-shadow: 0 0 0 1px rgba(90, 196, 130, 0.2) inset;
  }

  &--out {
    opacity: 0.45;
    border-style: dashed;
  }
}
</style>
