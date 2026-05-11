<script setup lang="ts">
import type { HandHistory, Player } from '~/types/game'

const props = defineProps<{
  history: HandHistory[]
}>()

function findPlayer(players: Player[], playerId: string): Player | undefined {
  return players.find((player) => player.id === playerId)
}

function stackChanges(hand: HandHistory) {
  return hand.playerSnapshotsAfter.map((after) => {
    const before = findPlayer(hand.playerSnapshotsBefore, after.id)
    const delta = after.stack - (before?.stack ?? 0)
    return {
      playerId: after.id,
      name: after.name,
      beforeStack: before?.stack ?? 0,
      afterStack: after.stack,
      delta
    }
  })
}
</script>

<template>
  <section class="panel history-list">
    <h2>История раздач</h2>

    <p v-if="history.length === 0" class="history-list__empty">История пока пуста.</p>

    <details v-for="hand in history" :key="hand.handNumber" class="history-list__item">
      <summary>
        <span>Раздача #{{ hand.handNumber }}</span>
        <span>Банк: {{ hand.pot }}</span>
      </summary>

      <div class="history-list__content">
        <div>
          <h3>Победители</h3>
          <ul>
            <li v-for="winner in hand.winners" :key="winner.playerId">
              {{ findPlayer(hand.playerSnapshotsAfter, winner.playerId)?.name || winner.playerId }}: +{{ winner.amountWon }}
            </li>
          </ul>
        </div>

        <div>
          <h3>Изменения стеков</h3>
          <ul>
            <li v-for="change in stackChanges(hand)" :key="change.playerId">
              {{ change.name }}: {{ change.beforeStack }} → {{ change.afterStack }}
              <strong :class="{ up: change.delta > 0, down: change.delta < 0 }">
                ({{ change.delta > 0 ? '+' : '' }}{{ change.delta }})
              </strong>
            </li>
          </ul>
        </div>
      </div>
    </details>
  </section>
</template>

<style scoped lang="scss">
.history-list {
  display: grid;
  gap: 0.8rem;

  h2 {
    margin: 0;
  }

  &__empty {
    margin: 0;
    color: var(--text-muted);
  }

  &__item {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-md);
    padding: 0.45rem 0.7rem;
    background: rgba(255, 255, 255, 0.04);

    summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 0.8rem;
      font-weight: 600;
    }
  }

  &__content {
    display: grid;
    gap: 0.7rem;
    margin-top: 0.6rem;

    h3 {
      margin: 0;
      font-size: var(--text-md);
    }

    ul {
      margin: 0.35rem 0 0;
      padding-left: 1rem;
    }
  }
}

.up {
  color: var(--success);
}

.down {
  color: var(--danger);
}
</style>
