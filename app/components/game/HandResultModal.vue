<script setup lang="ts">
defineProps<{
  open: boolean
  title: string
  text: string
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="hand-result-modal">
      <section class="panel hand-result-modal__box">
        <h3>{{ title }}</h3>
        <p>{{ text }}</p>
        <button type="button" class="btn" @click="emit('close')">Ок</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.hand-result-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 1200;

  &__box {
    width: min(92vw, 460px);
  }
}
</style>
