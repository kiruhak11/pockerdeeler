<script setup lang="ts">
import type { RoomChatMessage } from '~/types/social'
defineProps<{ message: RoomChatMessage }>()
const emit = defineEmits<{ shown: []; open: [] }>()
const started = ref(false)
let frame = 0
onMounted(() => {
  frame = requestAnimationFrame(() => { started.value = true; emit('shown') })
})
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <div class="room-chat-toast" aria-live="polite" aria-atomic="true">
    <button type="button" aria-label="Открыть новое сообщение в чате" @click="emit('open')">
      <strong>{{ message.senderName }}</strong><span>{{ message.text }}</span>
      <span class="room-chat-toast__progress" :class="{ 'is-started': started }" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.room-chat-toast {
  position: fixed; z-index: 46; top: calc(5px + env(safe-area-inset-top, 0px)); left: max(10px, env(safe-area-inset-left, 0px));
  width: min(420px, calc(100vw - 20px));
  button { position: relative; overflow: hidden; display: flex; gap: 10px; align-items: center; width: 100%; height: 44px;
    border: 1px solid #f2b45166; border-radius: 12px; padding: 8px 12px; background: var(--bg-surface); color: var(--text-primary); text-align: left; cursor: pointer;
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  }
  strong { max-width: 35%; font-size: .85rem; flex-shrink: 0; }
  strong, span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  span { font-size: .85rem; }
  &__progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); transform-origin: left; }
  &__progress.is-started { animation: chat-countdown 3s linear forwards; }
}
@keyframes chat-countdown { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { .room-chat-toast__progress.is-started { animation: none; opacity: .55; } }
</style>
