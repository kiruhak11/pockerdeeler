<script setup lang="ts">
import type { OnlinePlayerAction, Player } from '~/types/game'

const props = defineProps<{
  pendingActions: OnlinePlayerAction[]
  players: Player[]
}>()

const emit = defineEmits<{
  approve: [actionId: string]
  reject: [actionId: string]
}>()

function nameById(playerId: string) {
  return props.players.find((player) => player.id === playerId)?.name ?? playerId
}
</script>

<template>
  <section class="panel pending-actions">
    <h3>Ожидают подтверждения</h3>
    <p v-if="pendingActions.length === 0">Нет ожидающих действий</p>

    <div v-for="action in pendingActions" :key="action.id" class="pending-actions__item">
      <p>{{ nameById(action.playerId) }}: {{ action.type }} {{ action.amount }}</p>
      <div>
        <button type="button" class="btn btn--success" @click="emit('approve', action.id)">Подтвердить</button>
        <button type="button" class="btn btn--danger" @click="emit('reject', action.id)">Отклонить</button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.pending-actions {
  display: grid;
  gap: 0.6rem;

  h3,
  p {
    margin: 0;
  }

  &__item {
    padding: 0.6rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-sm);
    display: grid;
    gap: 0.4rem;

    div {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
  }
}
</style>
