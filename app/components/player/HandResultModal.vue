<script setup lang="ts">
defineProps<{
  visible: boolean
  title: string
  delta: number
  finalStack: number
  handNumber: number
}>()

function deltaLabel(delta: number): string {
  if (delta > 0) {
    return `+${delta}`
  }
  return `${delta}`
}
</script>

<template>
  <Teleport to="body">
    <transition name="hand-result-fade">
      <div v-if="visible" class="hand-result-modal">
        <div class="hand-result-modal__card">
          <h3>{{ title }}</h3>
          <p>Раздача #{{ handNumber }}</p>
          <p>Изменение: <strong>{{ deltaLabel(delta) }}</strong></p>
          <p>Текущий баланс: <strong>{{ finalStack }}</strong></p>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped lang="scss">
.hand-result-modal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(5, 12, 9, 0.65);
  z-index: 1200;
  padding: 1rem;

  &__card {
    width: min(440px, 100%);
    border-radius: var(--radius-lg);
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #12241a;
    padding: 1rem;
    display: grid;
    gap: 0.45rem;

    h3,
    p {
      margin: 0;
    }

    p {
      color: var(--text-muted);
    }

    strong {
      color: var(--text);
    }
  }
}

.hand-result-fade-enter-active,
.hand-result-fade-leave-active {
  transition: opacity 0.22s ease;
}

.hand-result-fade-enter-from,
.hand-result-fade-leave-to {
  opacity: 0;
}
</style>
