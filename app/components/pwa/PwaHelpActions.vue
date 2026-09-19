<script setup lang="ts">
const { state, openInstallHelp, openOnboarding } = usePwa()
const { safeToPrompt } = usePwaSafety()
</script>

<template>
  <div class="pwa-help-actions" aria-label="Помощь">
    <button type="button" class="btn btn--ghost" :disabled="!safeToPrompt" @click="openOnboarding">Как играть</button>
    <button v-if="!state.standalone" type="button" class="btn btn--ghost" :disabled="!safeToPrompt" @click="openInstallHelp">Как установить</button>
    <span v-if="!safeToPrompt">Помощь доступна вне раздачи.</span>
  </div>
</template>

<style scoped>
.pwa-help-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
button { min-height: 44px; }
span { color: var(--text-muted); font-size: .85rem; }
</style>
