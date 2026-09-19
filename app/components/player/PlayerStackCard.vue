<script setup lang="ts">
import type { Player } from '~/types/game'
const statusLabels: Record<Player['status'], string> = {
  waiting: 'Ожидает новой раздачи', active: 'В игре', checked: 'Чек', folded: 'Карты сброшены',
  'all-in': 'Ва-банк', winner: 'Победитель', out: 'Выбыли из игры за столом'
}

defineProps<{
  player: Player | null
  pot: number
  currentBet: number
  callAmount: number
  isMyTurn: boolean
  currentPlayerName: string | null
}>()
</script>

<template>
  <section class="panel player-stack-card">
    <h3 title="Фишки, оставшиеся у вас">Ваш стек: {{ player?.stack ?? '-' }}</h3>
    <p title="Все фишки, внесённые в раздачу">Общий банк: {{ pot }}</p>
    <p>Ставка стола за круг: {{ currentBet }}</p>
    <p>Вы уже внесли за круг: {{ player?.currentBet ?? 0 }}</p>
    <p v-if="player && ['active', 'checked'].includes(player.status)">Доплатить для уравнивания: {{ Math.min(player.stack, callAmount) }}<span v-if="callAmount >= player.stack && player.stack > 0"> (весь стек)</span></p>
    <p>Ваш статус: {{ player ? statusLabels[player.status] : '-' }}</p>
    <p class="turn" :class="{ 'turn--active': isMyTurn }" role="status">
      {{ isMyTurn ? 'СЕЙЧАС ВАШ ХОД' : `Сейчас ход: ${currentPlayerName || '—'}` }}
    </p>
  </section>
</template>

<style scoped lang="scss">
.player-stack-card {
  overflow-wrap: anywhere;
  h3,
  p {
    margin: 0;
  }

  p {
    margin-top: 0.35rem;
    color: var(--text-muted);
  }

  .turn {
    padding: 0.65rem 0.75rem;
    border-radius: var(--radius-sm);
    font-weight: 700;
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
  }

  .turn--active {
    color: var(--success);
    background: rgba(91, 214, 139, 0.14);
    font-size: 1.1rem;
    letter-spacing: 0.02em;
  }
}
</style>
