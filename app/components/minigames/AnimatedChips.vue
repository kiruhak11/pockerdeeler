<script setup lang="ts">
const props = defineProps<{ value?: number | null }>()
const shown = ref(props.value ?? 0)
let frame = 0
let mounted = false
function animate() {
  cancelAnimationFrame(frame)
  const target = props.value ?? 0
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { shown.value = target; return }
  const start = shown.value, time = performance.now()
  function step(t: number) { const p = Math.min(1, (t - time) / 850); shown.value = start + (target - start) * (1 - (1 - p) ** 3); if (p < 1) frame = requestAnimationFrame(step) }
  frame = requestAnimationFrame(step)
}
watch(() => props.value, () => { if (mounted) animate() })
onMounted(() => { mounted = true; animate() })
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>
<template><span class="animated-chips">{{ value == null ? '—' : shown.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) }}</span></template>
<style scoped>.animated-chips{font-variant-numeric:tabular-nums}</style>
