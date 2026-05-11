<script setup lang="ts">
const props = defineProps<{
  status: 'disconnected' | 'connecting' | 'connected'
}>()

const label = computed(() => {
  if (props.status === 'connected') {
    return 'Онлайн'
  }

  if (props.status === 'connecting') {
    return 'Подключение...'
  }

  return 'Оффлайн'
})
</script>

<template>
  <span class="tag" :class="`conn conn--${status}`">{{ label }}</span>
</template>

<style scoped lang="scss">
.conn--connected {
  color: var(--success);
}

.conn--disconnected {
  color: var(--danger);
}
</style>
