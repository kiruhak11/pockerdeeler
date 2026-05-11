<script setup lang="ts">
const emit = defineEmits<{
  'start-game': []
  'start-hand': []
  'finish-hand': []
  'undo': []
}>()
</script>

<template>
  <section class="panel dealer-controls">
    <button type="button" class="btn" @click="emit('start-game')">Запустить игру</button>
    <button type="button" class="btn" @click="emit('start-hand')">Новая раздача</button>
    <button type="button" class="btn btn--ghost" @click="emit('finish-hand')">Завершить раздачу</button>
    <button type="button" class="btn btn--ghost" @click="emit('undo')">Отменить действие</button>
  </section>
</template>

<style scoped lang="scss">
.dealer-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
</style>
