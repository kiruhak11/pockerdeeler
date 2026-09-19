<script setup lang="ts">
import type { Player, SidePot } from '~/types/game'
import { calculatePots } from '~/utils/pokerCalculations'

const props = defineProps<{ players: Player[]; busy?: boolean }>()
const emit = defineEmits<{ distribute: [winnerIds: string[], potWinners?: Record<string, string[]>] }>()

const selected = ref<string[]>([])
const potSelections = ref<Record<string, string[]>>({})
const eligiblePlayers = computed(() => props.players.filter((player) =>
  !['folded', 'out', 'waiting'].includes(player.status) && player.totalCommitted > 0
))
const selectedPlayers = computed(() => eligiblePlayers.value.filter((player) => selected.value.includes(player.id)))
const playersById = computed(() => new Map(props.players.map((player) => [player.id, player])))
const pots = computed(() => calculatePots(props.players))

function contestedPots(potList: SidePot[]) {
  return potList.filter((pot) => pot.eligiblePlayerIds.length > 1)
}

const unresolvedPots = computed(() => contestedPots(pots.value).filter((pot) => {
  const explicit = potSelections.value[String(pot.id)]
  const winners = explicit?.length ? explicit : selected.value
  return !pot.eligiblePlayerIds.some((playerId) => winners.includes(playerId))
}))

function potWinnerNames(pot: SidePot) {
  return pot.eligiblePlayerIds
    .map((playerId) => playersById.value.get(playerId)?.name)
    .filter(Boolean)
    .join(', ')
}

function toggle(playerId: string) {
  selected.value = selected.value.includes(playerId)
    ? selected.value.filter((id) => id !== playerId)
    : [...selected.value, playerId]
}

function togglePotWinner(potId: number, playerId: string) {
  const key = String(potId)
  const current = potSelections.value[key] || []
  potSelections.value = {
    ...potSelections.value,
    [key]: current.includes(playerId)
      ? current.filter((id) => id !== playerId)
      : [...current, playerId]
  }
}

function submit() {
  if (!selected.value.length || props.busy || unresolvedPots.value.length) return

  const explicitSelections = Object.fromEntries(
    contestedPots(pots.value)
      .map((pot) => {
        const key = String(pot.id)
        const winners = potSelections.value[key]?.length
          ? potSelections.value[key]
          : selected.value.filter((playerId) => pot.eligiblePlayerIds.includes(playerId))
        return [key, winners]
      })
      .filter(([, winners]) => (winners as string[]).length > 0)
  ) as Record<string, string[]>

  emit('distribute', [...selected.value], explicitSelections)
}
</script>

<template>
  <section class="panel dealer-winner-selector">
    <div class="dealer-winner-selector__heading">
      <div>
        <p class="eyebrow">Раздача завершена</p>
        <h3>Кто выиграл?</h3>
      </div>
      <span class="dealer-winner-selector__count">{{ selected.length }} выбрано</span>
    </div>

    <p class="page-subtitle">
      Выберите одного или нескольких победителей. Система сама распределит доступный банк,
      учтет all-in и разделит остаток фишек без потерь.
    </p>

    <div v-if="eligiblePlayers.length" class="dealer-winner-selector__grid">
      <button
        v-for="player in eligiblePlayers"
        :key="player.id"
        type="button"
        class="winner-option"
        :class="{ 'winner-option--selected': selected.includes(player.id) }"
        :disabled="busy"
        @click="toggle(player.id)"
      >
        <span class="winner-option__check">{{ selected.includes(player.id) ? '✓' : '' }}</span>
        <span class="winner-option__body">
          <strong>{{ player.name }}</strong>
          <small>Стек: {{ player.stack }} · Вложено: {{ player.totalCommitted }}</small>
        </span>
        <span v-if="player.status === 'all-in'" class="tag tag--warning">Ва-банк</span>
      </button>
    </div>

    <p v-else class="page-subtitle">Нет игроков, которые могут получить этот банк.</p>

    <p v-if="selectedPlayers.length" class="dealer-winner-selector__hint">
      Выбраны: {{ selectedPlayers.map((player) => player.name).join(', ') }}
    </p>

    <section v-if="unresolvedPots.length" class="pot-winner-resolution">
      <div>
        <strong>Нужно уточнить победителя банка</strong>
        <p>Игрок, выигравший основной банк, не всегда имеет право на каждый боковой банк. Выберите победителя для каждого банка ниже.</p>
      </div>

      <div v-for="pot in unresolvedPots" :key="pot.id" class="pot-winner-resolution__item">
        <div class="pot-winner-resolution__title">
          <strong>Банк №{{ pot.id }} · {{ pot.amount }}</strong>
          <small>Доступны: {{ potWinnerNames(pot) }}</small>
        </div>
        <div class="pot-winner-resolution__options">
          <button
            v-for="playerId in pot.eligiblePlayerIds"
            :key="playerId"
            type="button"
            class="pot-winner-option"
            :class="{ 'pot-winner-option--selected': potSelections[String(pot.id)]?.includes(playerId) }"
            :disabled="busy"
            @click="togglePotWinner(pot.id, playerId)"
          >
            {{ playersById.get(playerId)?.name || 'Игрок' }}
          </button>
        </div>
      </div>
    </section>

    <button type="button" class="btn btn--success" :disabled="!selected.length || busy || unresolvedPots.length > 0" @click="submit">
      {{ busy ? 'Распределяем…' : 'Распределить банк автоматически' }}
    </button>
  </section>
</template>

<style scoped lang="scss">
.dealer-winner-selector {
  display: grid;
  gap: 0.75rem;

  h3,
  p {
    margin: 0;
  }

  &__heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  &__count,
  &__hint {
    color: var(--accent);
    font-weight: 700;
  }

  &__grid {
    display: grid;
    gap: 0.55rem;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

.eyebrow {
  margin-bottom: 0.2rem !important;
  color: var(--accent);
  font-size: var(--text-xs);
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.winner-option {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 64px;
  padding: 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius-md);
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  &--selected {
    border-color: var(--accent);
    background: rgba(245, 183, 77, 0.16);
    box-shadow: 0 0 0 1px rgba(245, 183, 77, 0.2);
  }

  &__check {
    display: grid;
    flex: 0 0 26px;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 50%;
    color: #102119;
    background: transparent;
    font-weight: 900;
  }

  &--selected &__check {
    border-color: var(--accent);
    background: var(--accent);
  }

  &__body {
    display: grid;
    flex: 1;
    gap: 0.2rem;

    small {
      color: var(--text-muted);
    }
  }
}

.tag--warning {
  color: #271a06;
  background: #f5b74d;
}

.pot-winner-resolution {
  display: grid;
  gap: 0.7rem;
  padding: 0.85rem;
  border: 1px solid rgba(245, 183, 77, 0.45);
  border-radius: var(--radius-md);
  background: rgba(245, 183, 77, 0.08);

  p,
  small {
    color: var(--text-muted);
  }

  p {
    margin: 0.25rem 0 0;
  }

  &__item {
    display: grid;
    gap: 0.5rem;
    padding-top: 0.65rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  &__title {
    display: grid;
    gap: 0.15rem;
  }

  &__options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
}

.pot-winner-option {
  padding: 0.5rem 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;

  &--selected {
    border-color: var(--accent);
    color: #102119;
    background: var(--accent);
  }
}
</style>
