<script setup lang="ts">
import type { Player } from '~/types/game'

const props = defineProps<{
  players: Player[]
}>()

const emit = defineEmits<{
  distribute: [winnerIds: string[]]
}>()

const selected = ref<string[]>([])

const activePlayers = computed(() => props.players.filter((player) => player.status !== 'folded' && player.status !== 'out'))

function toggle(playerId: string) {
  const set = new Set(selected.value)
  if (set.has(playerId)) {
    set.delete(playerId)
  } else {
    set.add(playerId)
  }

  selected.value = [...set]
}

function submit() {
  if (selected.value.length === 0) {
    return
  }

  emit('distribute', selected.value)
}
</script>

<template>
  <section class="panel dealer-winner-selector">
    <h3>Победители</h3>
    <div class="dealer-winner-selector__grid">
      <button
        v-for="player in activePlayers"
        :key="player.id"
        type="button"
        class="btn btn--ghost"
        :class="{ selected: selected.includes(player.id) }"
        @click="toggle(player.id)"
      >
        {{ player.name }}
      </button>
    </div>

    <button type="button" class="btn btn--success" :disabled="selected.length === 0" @click="submit">
      Распределить банк
    </button>
  </section>
</template>

<style scoped lang="scss">
.dealer-winner-selector {
  display: grid;
  gap: 0.6rem;

  h3 {
    margin: 0;
  }

  &__grid {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
}

.selected {
  border: 1px solid var(--success);
}
</style>
