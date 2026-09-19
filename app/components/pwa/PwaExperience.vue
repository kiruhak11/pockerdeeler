<script setup lang="ts">
import IntroOnboarding from '../onboarding/IntroOnboarding.vue'
import PwaHelpActions from './PwaHelpActions.vue'
import PwaInstallHelp from './PwaInstallHelp.vue'
import { ONBOARDING_VERSION, isInstallProposalDue } from '~/composables/usePwaPreferences'
const route = useRoute()
const { state, persist, openInstallHelp } = usePwa()
const { safeToPrompt, safeToUpdate } = usePwaSafety()
const now = ref(Date.now())
const automaticOnboardingShown = ref(false)
const installEligible = computed(() => !state.value.standalone && !state.value.installedThisSession && !state.value.preferences.installSuppressed)
const showHelp = computed(() => ['/', '/profile'].includes(route.path))
const localRoute = computed(() => ['/setup', '/game', '/history'].includes(route.path))
let timer: ReturnType<typeof setInterval>
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 30000) })
onBeforeUnmount(() => clearInterval(timer))

watchEffect(() => {
  if (!safeToPrompt.value) {
    state.value.dialog = null
    return
  }
  if (state.value.dialog) return
  if (!automaticOnboardingShown.value && state.value.preferences.onboardingVersion < ONBOARDING_VERSION) {
    automaticOnboardingShown.value = true
    state.value.dialog = 'onboarding'
    return
  }
  if (installEligible.value && isInstallProposalDue(state.value.preferences, now.value)) {
    state.value.preferences.lastInstallProposal = now.value
    persist()
    state.value.dialog = 'install'
  }
})

function update() { window.dispatchEvent(new Event('poker:update')) }
</script>

<template>
  <section v-if="state.ready" class="pwa-experience" aria-label="Приложение и помощь">
    <p v-if="!state.online" class="pwa-network" role="status">{{ localRoute ? 'Нет сети. Локальный стол работает только на этом устройстве.' : 'Нет сети. Онлайн-комнате нужен интернет; дождитесь восстановления связи.' }}</p>
    <p v-else-if="!state.serverReachable" class="pwa-network" role="status">Сервер временно недоступен. Проверьте соединение с сайтом и повторите подключение.</p>
    <div v-if="safeToPrompt && installEligible && !state.dialog" class="pwa-banner">
      <img src="/pwa/icon-192.png" width="36" height="36" alt="">
      <span>Игра на экране Домой</span>
      <button type="button" class="btn btn--ghost" @click="openInstallHelp">Как установить</button>
    </div>
    <div v-if="safeToUpdate && state.updateReady && !state.dialog" class="pwa-update" role="status">
      <p>Доступна новая версия. Обновление перезагрузит эту страницу; сначала завершите действия во всех вкладках.</p>
      <button type="button" class="btn" :disabled="state.updating" @click="update">{{ state.updating ? 'Проверяем вкладки…' : 'Обновить приложение' }}</button>
      <p v-if="state.message">{{ state.message }}</p>
    </div>
    <PwaHelpActions v-if="showHelp" class="pwa-help" />
    <p v-if="localRoute && safeToPrompt" class="pwa-network">{{ state.offlineReady ? 'Локальный режим готов к работе без интернета на этом устройстве.' : 'Офлайн-оболочка ещё не загружена. Пока не закрывайте страницу без сети.' }}</p>
  </section>
  <IntroOnboarding v-if="safeToPrompt && state.dialog === 'onboarding'" />
  <PwaInstallHelp v-if="safeToPrompt && !state.standalone && state.dialog === 'install'" />
</template>

<style scoped>
.pwa-experience { max-width: 1200px; margin: 0 auto; padding: 0 max(12px, env(safe-area-inset-left, 0px)) 0 max(12px, env(safe-area-inset-right, 0px)); }
.pwa-banner { margin-top: max(10px, env(safe-area-inset-top, 0px)); display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #f2b45166; border-radius: 16px; background: linear-gradient(105deg, #364a2c, #17231f); }
.pwa-banner span { flex: 1; font-weight: 600; }
.pwa-banner img { border-radius: 9px; }
.pwa-banner button { min-height: 44px; }
.pwa-network { color: var(--text-muted); font-size: .9rem; margin: 10px 0; }
.pwa-update { margin: 10px 0; padding: 14px; border: 1px solid var(--accent); border-radius: 16px; background: var(--bg-surface); }
.pwa-update p { margin: 0 0 10px; line-height: 1.5; }
.pwa-help { padding: 12px 0; }
</style>
