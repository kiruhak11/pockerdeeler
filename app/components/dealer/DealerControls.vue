<script setup lang="ts">
import type { OnlineGameSession, OnlineHand } from '~/types/game'
defineProps<{
  canRestartGame?: boolean
  busy?: boolean
  session: OnlineGameSession | null
  hand: OnlineHand | null
}>()

const emit = defineEmits<{
  'start-game': []
  'restart-game': []
  'start-hand': []
  'finish-hand': []
  'undo': []
}>()
</script>

<template>
  <section class="panel dealer-controls">
    <button v-if="session?.status === 'lobby'" type="button" class="btn" :disabled="busy" @click="emit('start-game')">Запустить игру</button>
    <button v-if="canRestartGame && !hand && session?.status === 'playing'" type="button" class="btn btn--success" :disabled="busy" @click="emit('restart-game')">
      Начать заново тем же составом
    </button>
    <button type="button" class="btn" :disabled="busy || !!hand || session?.status !== 'playing'" @click="emit('start-hand')">Новая раздача</button>
    <button type="button" class="btn btn--ghost" :disabled="busy || hand?.status !== 'active' || (!!hand?.bettingState && hand.bettingState.phase !== 'showdown')" @click="emit('finish-hand')">Выбрать победителей</button>
    <button type="button" class="btn btn--ghost" :disabled="busy || hand?.status !== 'active'" @click="emit('undo')">Отменить действие</button>
  </section>
</template>

<style scoped lang="scss">
.dealer-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
</style>
