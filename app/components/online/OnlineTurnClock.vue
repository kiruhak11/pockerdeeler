<script setup lang="ts">
import { formatTurnSeconds, remainingTurnSeconds } from '~/utils/onlineRoomUi'

const props = defineProps<{ deadline: number }>()
const now = ref(Date.now())
let interval: ReturnType<typeof setInterval> | undefined
const seconds = computed(() => remainingTurnSeconds(props.deadline, now.value))

onMounted(() => { interval = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (interval) clearInterval(interval) })
</script>

<template>
  <span class="turn-clock" role="timer" :aria-label="`До конца хода ${formatTurnSeconds(seconds)}`">
    <span aria-hidden="true">◷</span>{{ formatTurnSeconds(seconds) }}
  </span>
</template>

<style scoped lang="scss">
.turn-clock { display: inline-flex; align-items: center; gap: .38rem; min-height: 38px; padding: .35rem .65rem; border: 1px solid rgba(242,180,81,.34); border-radius: 999px; color: #f2d38f; background: rgba(242,180,81,.1); font: 700 .9rem 'Space Grotesk', sans-serif; font-variant-numeric: tabular-nums; }
.turn-clock > span { font-size: 1.1rem; }
</style>
