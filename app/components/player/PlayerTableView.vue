<script setup lang="ts">
import type { Player } from '~/types/game'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'

const props = defineProps<{
  players: Player[]
  selfPlayerId: string | null
  currentPlayerId: string | null
  smallBlindPlayerId: string | null
  bigBlindPlayerId: string | null
}>()
const emit = defineEmits<{ selectPlayer: [player: Player] }>()

const visiblePlayers = computed(() =>
  props.players.filter((player) => Boolean(player.participantId) || player.totalCommitted > 0)
)
const statusLabels: Record<Player['status'], string> = {
  waiting: 'Ждёт раздачи', active: 'В игре', checked: 'Чек', folded: 'Пас', 'all-in': 'Ва-банк', winner: 'Победитель', out: 'Выбыл'
}
</script>

<template>
  <section class="panel player-table-view">
    <h3>Стол</h3>
    <ul>
      <li
        v-for="player in visiblePlayers"
        :key="player.id"
        :class="{
          'player-table-view__row--current': props.currentPlayerId === player.id,
          'player-table-view__row--self': props.selfPlayerId === player.id
        }"
        role="button"
        tabindex="0"
        :aria-label="`Открыть профиль игрока ${player.name}`"
        @click="emit('selectPlayer', player)"
        @keydown.enter="emit('selectPlayer', player)"
      >
        <span>{{ player.seat }}.</span>
        <span class="name">
          <span class="player-name-identity"><span class="player-name-text">{{ player.name }}</span><span v-if="player.achievementIcon" class="player-achievement"><AchievementBadge :code="player.achievementIcon" :size="18"/></span></span>
          <small v-if="props.selfPlayerId === player.id">(вы)</small>
          <small v-if="player.isAway">Отошёл</small>
          <small v-if="props.smallBlindPlayerId === player.id" title="Малый обязательный взнос">Малый блайнд</small>
          <small v-if="props.bigBlindPlayerId === player.id" title="Большой обязательный взнос">Большой блайнд</small>
        </span>
        <span>{{ player.stack }}</span>
        <span class="tag">{{ statusLabels[player.status] }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.player-table-view {
  h3 {
    margin: 0;
  }

  ul {
    margin: 0.6rem 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.4rem;
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(3rem, auto);
    gap: 0.4rem;
    align-items: center;
    padding: 0.35rem 0.45rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  &__row--current {
    background: rgba(255, 196, 0, 0.18);
  }

  &__row--self {
    outline: 1px solid rgba(255, 255, 255, 0.22);
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
    overflow-wrap: anywhere;
    gap: 0.35rem;
    align-items: baseline;

    .player-name-identity {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: .35rem;
      white-space: nowrap;
    }

    .player-name-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .player-achievement {
      display: inline-flex;
      flex: 0 0 auto;
      line-height: 0;
      align-items: center;
    }

    small {
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
  }
  .tag { grid-column: 2 / -1; justify-self: start; }
}
</style>
