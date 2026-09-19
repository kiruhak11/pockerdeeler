<script setup lang="ts">
import { useGameStore } from "~/stores/game"
import PwaExperience from '~/components/pwa/PwaExperience.vue'
import { useAccountStore } from '~/stores/account'
const gameStore = useGameStore()
const account = useAccountStore()
const seasonSummary = ref<any>(null)
const seasonModalOpen = ref(false)
async function checkSeasonResults() { if (!account.user) return; try { const response = await $fetch<any>('/api/season/me'); if (response.pendingResult) { seasonSummary.value = response.pendingResult; seasonModalOpen.value = true } } catch {} }
async function closeSeasonResults() {
  seasonModalOpen.value = false
  try { await $fetch('/api/season/acknowledge', { method: 'POST' }) } catch {}
}

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }
  void checkSeasonResults()
})
watch(() => account.user?.id, () => void checkSeasonResults())
</script>

<template>
  <ClientOnly><PwaExperience /></ClientOnly>
  <div class="app-content"><NuxtPage /></div>
  <LegalFooter />
  <BottomNav />
  <ToastList />
  <SeasonResultsModal v-if="seasonModalOpen" :summary="seasonSummary" @close="closeSeasonResults" />
</template>

<style lang="scss">
#__nuxt { min-height: 100vh; display: flex; flex-direction: column; }
.app-content { flex: 1 0 auto; min-height: 0; padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px)); }
.legal-footer { flex: 0 0 auto; }
html { scroll-padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
</style>
