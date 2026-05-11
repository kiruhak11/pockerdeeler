<script setup lang="ts">
import { storeToRefs } from "pinia"
import type { ToastMessage } from "~/types/game"
import { useGameStore } from "~/stores/game"
const gameStore = useGameStore()
const { notifications } = storeToRefs(gameStore)

const timers = new Map<string, ReturnType<typeof setTimeout>>()

watch(
  notifications,
  (next) => {
    for (const toast of next) {
      if (timers.has(toast.id)) {
        continue
      }

      const timeout = setTimeout(() => {
        gameStore.removeToast(toast.id)
        timers.delete(toast.id)
      }, 3000)

      timers.set(toast.id, timeout)
    }

    const activeIds = new Set(next.map((toast: ToastMessage) => toast.id))
    for (const [id, timeout] of timers.entries()) {
      if (activeIds.has(id)) {
        continue
      }

      clearTimeout(timeout)
      timers.delete(id)
    }
  },
  { deep: true }
)

onBeforeUnmount(() => {
  for (const timeout of timers.values()) {
    clearTimeout(timeout)
  }
  timers.clear()
})
</script>

<template>
  <Teleport to="body">
    <div class="toast-list" aria-live="assertive" aria-atomic="true">
      <transition-group name="toast" tag="div" class="toast-list__items">
        <div v-for="toast in notifications" :key="toast.id" class="toast" :class="`toast--${toast.type}`">
          <span>{{ toast.text }}</span>
          <button type="button" @click="gameStore.removeToast(toast.id)">×</button>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.toast-list {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 1000;
  width: min(90vw, 28rem);

  &__items {
    display: grid;
    gap: 0.6rem;
  }
}

.toast {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  background: rgba(20, 24, 22, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-md);
  padding: 0.75rem 0.95rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);

  &--error {
    border-color: rgba(233, 98, 98, 0.7);
  }

  &--success {
    border-color: rgba(90, 196, 130, 0.7);
  }

  &--info {
    border-color: rgba(233, 206, 98, 0.7);
  }

  button {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border: 0;
    color: inherit;
    background: transparent;
    font-size: 1.1rem;
    cursor: pointer;
  }
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
