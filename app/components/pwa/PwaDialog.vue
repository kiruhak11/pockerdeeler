<script setup lang="ts">
defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="pwa-dialog" aria-labelledby="pwa-dialog-title" @cancel.prevent="emit('close')">
      <header>
        <h2 id="pwa-dialog-title">{{ title }}</h2>
        <button type="button" class="btn btn--ghost" aria-label="Закрыть" @click="emit('close')">×</button>
      </header>
      <slot />
    </dialog>
  </Teleport>
</template>

<style scoped>
.pwa-dialog { box-sizing: border-box; width: min(560px, calc(100% - 24px)); max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px)); overflow-y: auto; overscroll-behavior: contain; margin: auto auto max(12px, env(safe-area-inset-bottom, 0px)); padding: 22px; border: 1px solid #627057; border-radius: 24px; color: var(--text-primary); background: radial-gradient(ellipse at top left, #304a31, #17231f 70%); box-shadow: 0 20px 80px #0008; }
.pwa-dialog::backdrop { background: #030b08b8; }
header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
h2 { margin: 0; flex: 1; font-size: 1.4rem; line-height: 1.3; }
:deep(p), :deep(li) { line-height: 1.55; }
:deep(.pwa-actions) { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
:deep(button), :deep(a.btn) { min-height: 44px; }
:deep(button:focus-visible), :deep(a:focus-visible) { outline: 3px solid var(--accent-strong); outline-offset: 3px; }
@media (min-width: 700px) { .pwa-dialog { margin: auto; } }
</style>
