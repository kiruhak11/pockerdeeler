<script setup lang="ts">
import type { Player } from '~/types/game'

const emit = defineEmits<{
  select: [playerId: string]
}>()

defineProps<{
  player: Player
  isCurrentPlayer?: boolean
  isDealerButton?: boolean
  isSmallBlind?: boolean
  isBigBlind?: boolean
}>()
</script>

<template>
  <article
    class="dealer-player-card"
    :class="[
      `dealer-player-card--${player.status}`,
      { 'dealer-player-card--current': isCurrentPlayer }
    ]"
    @click="emit('select', player.id)"
  >
    <header>
      <strong>{{ player.name }}</strong>
      <div class="dealer-player-card__badges">
        <span v-if="isDealerButton" class="tag">D</span>
        <span v-if="isSmallBlind" class="tag">SB</span>
        <span v-if="isBigBlind" class="tag">BB</span>
        <span v-if="isCurrentPlayer" class="tag tag--turn">Ход</span>
        <span v-if="player.isConnected === false" class="tag tag--offline">Отключен</span>
        <span class="tag">{{ player.status }}</span>
      </div>
    </header>
    <p>Место: {{ player.seat }}</p>
    <p>Стек: {{ player.stack }}</p>
    <p>Ставка: {{ player.currentBet }}</p>
    <p>Вложено: {{ player.totalCommitted }}</p>
  </article>
</template>

<style scoped lang="scss">
.dealer-player-card {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: var(--radius-md);
  padding: 0.7rem;
  background: rgba(255, 255, 255, 0.04);

  header,
  p {
    margin: 0;
  }

  p {
    margin-top: 0.3rem;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
  }

  &__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  &--current {
    border-color: rgba(255, 196, 0, 0.72);
    box-shadow: 0 0 0 1px rgba(255, 196, 0, 0.3);
  }

  .tag--turn {
    background: rgba(255, 196, 0, 0.22);
    color: #fff8c7;
  }

  .tag--offline {
    background: rgba(138, 138, 138, 0.3);
    color: #d6d6d6;
  }

  cursor: pointer;
}
</style>
