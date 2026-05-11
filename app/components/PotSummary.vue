<script setup lang="ts">
import type { GameVariant, HandStage, Player } from '~/types/game'

const props = defineProps<{
  pot: number
  currentBet: number
  handNumber: number
  stage: HandStage
  variant: GameVariant
  smallBlind: number
  bigBlind: number
  players: Player[]
}>()

const activePlayersCount = computed(
  () => props.players.filter((player) => player.status !== 'folded' && player.status !== 'out').length
)

const allInCount = computed(() => props.players.filter((player) => player.status === 'all-in').length)

const stageLabelMap: Record<HandStage, string> = {
  setup: 'Настройка',
  playing: 'Идет раздача',
  showdown: 'Выбор победителя',
  completed: 'Раздача завершена'
}

const variantLabelMap: Record<GameVariant, string> = {
  'texas-holdem': 'Техасский холдем',
  omaha: 'Омаха'
}
</script>

<template>
  <section class="panel pot-summary">
    <div>
      <p class="pot-summary__label">Банк</p>
      <div class="kpi">{{ pot }}</div>
    </div>

    <div class="pot-summary__stats">
      <div>
        <p class="pot-summary__label">Макс. ставка</p>
        <p class="pot-summary__value">{{ currentBet }}</p>
      </div>
      <div>
        <p class="pot-summary__label">Раздача</p>
        <p class="pot-summary__value">#{{ handNumber || 1 }}</p>
      </div>
      <div>
        <p class="pot-summary__label">Блайнды</p>
        <p class="pot-summary__value">{{ smallBlind }}/{{ bigBlind }}</p>
      </div>
      <div>
        <p class="pot-summary__label">В игре</p>
        <p class="pot-summary__value">{{ activePlayersCount }}/{{ players.length }}</p>
      </div>
      <div>
        <p class="pot-summary__label">Ва-банк</p>
        <p class="pot-summary__value">{{ allInCount }}</p>
      </div>
      <div>
        <p class="pot-summary__label">Вариант</p>
        <p class="pot-summary__value">{{ variantLabelMap[variant] }}</p>
      </div>
      <div>
        <p class="pot-summary__label">Стадия</p>
        <span class="tag">{{ stageLabelMap[stage] }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pot-summary {
  display: grid;
  grid-template-columns: minmax(180px, 260px) 1fr;
  gap: 1rem;
  align-items: center;

  &__label {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__value {
    margin: 0.3rem 0 0;
    font-size: 1.15rem;
    font-weight: 600;
  }

  &__stats {
    display: grid;
    grid-template-columns: repeat(7, minmax(120px, 1fr));
    gap: 0.8rem;
  }
}

@media (max-width: 900px) {
  .pot-summary {
    grid-template-columns: 1fr;

    &__stats {
      grid-template-columns: repeat(2, minmax(130px, 1fr));
    }
  }
}
</style>
