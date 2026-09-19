<script setup lang="ts">
const props = withDefaults(defineProps<{ name?: string; size?: number }>(), { name: 'spark', size: 24 })
const icon = computed(() => props.name || 'spark')
</script>
<template>
  <svg class="app-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path v-if="icon === 'check'" d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path v-else-if="icon === 'trophy'" d="M7 4h10v4a5 5 0 0 1-10 0V4Zm5 9v4m-4 3h8M4 6H2v2a4 4 0 0 0 4 4m14-6h2v2a4 4 0 0 1-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path v-else-if="icon.startsWith('medal')" d="m8 3 4 3 4-3 2 3-6 4-6-4 2-3Zm1 9h6l2 8-5-2-5 2 2-8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path v-else-if="icon === 'rocket'" d="M14 4c3-2 5-1 6-1 0 1 1 3-1 6l-6 6-4-4 5-7ZM9 15l-3 3m0-3-2 2m4-7L5 8m9 1 2-2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path v-else-if="icon === 'mine'" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-4v2m0 12v2M5 5l1.5 1.5m11-1.5L16 6.5M3 12h2m14 0h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path v-else-if="icon === 'wallet'" d="M4 7.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12v3H4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path v-else-if="icon === 'chart'" d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path v-else-if="icon === 'flame'" d="M12 21a5 5 0 0 0 5-5c0-3-2-5-4-7 0 2-1 3-2 3-1-2-1-4 0-7-4 2-6 6-6 10a5 5 0 0 0 5 6h2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path v-else-if="icon === 'target'" d="M12 21a9 9 0 1 0-9-9m9 5a5 5 0 1 0-5-5m5 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0-10v3m9 7h-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path v-else d="M12 2.8 14 10l7.2 2-7.2 2-2 7.2-2-7.2-7.2-2 7.2-2 2-7.2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>
</template>
