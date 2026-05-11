<script setup lang="ts">
import type { Player } from '~/types/game'
import { distributePot } from '~/utils/pokerCalculations'

const props = defineProps<{
  players: Player[]
  pot: number
  selected: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:selected': [ids: string[]]
  distribute: []
}>()

const eligiblePlayers = computed(() =>
  props.players.filter((player) => player.status !== 'folded' && player.status !== 'out')
)

const selectedSet = computed(() => new Set(props.selected))

function toggleWinner(playerId: string) {
  if (props.disabled) {
    return
  }

  const next = new Set(props.selected)
  if (next.has(playerId)) {
    next.delete(playerId)
  } else {
    next.add(playerId)
  }

  emit('update:selected', [...next])
}

const preview = computed(() => {
  if (!props.selected.length) {
    return null
  }

  try {
    const { result } = distributePot(props.players, props.selected)
    return result
  } catch {
    return null
  }
})
</script>

<template>
  <section class="panel winner-selector">
    <header>
      <h2>Завершение раздачи</h2>
      <p>Выберите победителя(ей). Остаток при делении идет по порядку места, затем по id.</p>
    </header>

    <div class="winner-selector__list">
      <button
        v-for="player in eligiblePlayers"
        :key="player.id"
        type="button"
        class="winner-selector__player"
        :class="{ 'winner-selector__player--selected': selectedSet.has(player.id) }"
        :disabled="disabled"
        @click="toggleWinner(player.id)"
      >
        <span>{{ player.name }}</span>
        <small>Вклад: {{ player.totalCommitted }}</small>
      </button>
    </div>

    <div class="winner-selector__preview">
      <p><strong>Банк:</strong> {{ pot }}</p>
      <template v-if="preview">
        <p><strong>Предпросмотр выплат:</strong></p>
        <ul>
          <li v-for="item in preview.winners" :key="`winner-${item.playerId}`">
            {{ players.find((player) => player.id === item.playerId)?.name || item.playerId }}: +{{ item.amountWon }}
          </li>
          <li v-for="item in preview.returned" :key="`return-${item.playerId}`">
            Возврат {{ players.find((player) => player.id === item.playerId)?.name || item.playerId }}: +{{ item.amountWon }}
          </li>
        </ul>
      </template>
    </div>

    <button
      type="button"
      class="btn btn--success"
      :disabled="disabled || selected.length === 0"
      @click="emit('distribute')"
    >
      Распределить банк
    </button>
  </section>
</template>

<style scoped lang="scss">
.winner-selector {
  display: grid;
  gap: 1rem;

  h2,
  p {
    margin: 0;
  }

  p {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.65rem;
  }

  &__player {
    text-align: left;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-primary);
    padding: 0.65rem 0.7rem;
    cursor: pointer;
    display: grid;
    gap: 0.2rem;

    small {
      color: var(--text-muted);
    }

    &--selected {
      border-color: rgba(90, 196, 130, 0.8);
      background: rgba(90, 196, 130, 0.16);
    }
  }

  &__preview {
    ul {
      margin: 0.35rem 0 0;
      padding-left: 1rem;
    }

    li {
      margin: 0.2rem 0;
    }
  }
}
</style>
