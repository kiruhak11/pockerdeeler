<script setup lang="ts">
import type { Player } from '~/types/game'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'

const props = defineProps<{
  players: Player[]
  currentPlayerId?: string | null
  smallBlindPlayerId?: string | null
  bigBlindPlayerId?: string | null
}>()
const emit = defineEmits<{ selectPlayer: [player: Player] }>()

const visiblePlayers = computed(() =>
  props.players.filter((player) => player.isConnected !== false && Boolean(player.participantId))
)
</script>

<template>
  <section class="panel">
    <h3>Игроки за столом</h3>
    <ul>
      <li
        v-for="player in visiblePlayers"
        :key="player.id"
        :class="{
          'is-current': props.currentPlayerId === player.id,
          'is-folded': player.status === 'folded',
          'is-out': player.status === 'out'
        }"
        role="button"
        tabindex="0"
        :aria-label="`Открыть профиль игрока ${player.name}`"
        @click="emit('selectPlayer', player)"
        @keydown.enter="emit('selectPlayer', player)"
      >
        <span class="player-line"><span class="player-line__name"><span class="player-line__username">{{ player.seat }}. {{ player.name }}</span><span v-if="player.achievementIcon" class="player-achievement"><AchievementBadge :code="player.achievementIcon" :size="18"/></span></span><small class="player-line__status">{{ player.status === 'folded' ? 'Сбросил карты' : player.status === 'out' ? 'Выбыл' : `${player.stack} фишек` }}</small></span>
        <span class="marks">
          <span v-if="player.isAway" class="tag">Отошёл</span>
          <span v-if="props.smallBlindPlayerId === player.id" class="tag">SB</span>
          <span v-if="props.bigBlindPlayerId === player.id" class="tag">BB</span>
          <span v-if="props.currentPlayerId === player.id" class="tag">Ход</span>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
ul {
  margin: 0.6rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0.45rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.player-line {
  display: grid;
  min-width: 0;
  gap: 0.1rem;
}

.player-line__name {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: .35rem;
  white-space: nowrap;
}

.player-line__username {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-achievement {
  display: inline-flex;
  flex: 0 0 auto;
  line-height: 0;
}

.player-line__status {
  color: var(--text-muted);
  font-size: 0.72rem;
}

.is-folded {
  border: 1px solid rgba(255, 104, 95, 0.42);
  color: #ffb0aa;
  background: rgba(150, 40, 36, 0.2);
}

.is-folded .player-line__status {
  color: #ff8c83;
}

.is-out {
  opacity: 0.48;
  filter: grayscale(0.8);
  background: rgba(130, 138, 135, 0.12);
}

.is-current {
  background: rgba(255, 196, 0, 0.18);
}

.marks {
  display: flex;
  gap: 0.3rem;
}
</style>
