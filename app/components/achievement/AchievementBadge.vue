<script setup lang="ts">
const props = withDefaults(defineProps<{ code?: string | null; size?: number }>(), { size: 44 })

const asset = computed(() => {
  const code = String(props.code || '')
  return code.startsWith('season:') ? '/icons/achievements/season.svg' : `/icons/achievements/${code || 'fallback'}.svg`
})
</script>

<template>
  <img class="achievement-badge" :src="asset" :width="size" :height="size" alt="" aria-hidden="true" @error="($event.target as HTMLImageElement).src = '/icons/achievements/fallback.svg'">
</template>

<style scoped>
.achievement-badge { display: block; flex: 0 0 auto; object-fit: contain; }
</style>
