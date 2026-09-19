<script setup lang="ts">
const props = withDefaults(defineProps<{ plan?: string | null; size?: number }>(), { size: 48 })
const asset = computed(() => {
  const plan = String(props.plan || '').toUpperCase()
  return plan === 'LITE' || plan === 'PRO' || plan === 'ELITE' ? `/icons/premium/${plan.toLowerCase()}.svg` : '/icons/premium/premium.svg'
})
</script>

<template>
  <img class="premium-badge" :src="asset" :width="size" :height="size" alt="" aria-hidden="true" @error="($event.target as HTMLImageElement).src = '/icons/premium/premium.svg'">
</template>

<style scoped>
.premium-badge { display: block; flex: 0 0 auto; object-fit: contain; }
</style>
