<script setup lang="ts">
const {
  analyticsAllowed,
  hasCurrentConsent,
  settingsOpen,
  setAnalyticsAllowed,
  openPreferences,
  closePreferences
} = useCookieConsent()

const mounted = ref(false)
const analyticsDraft = ref(false)

onMounted(() => {
  mounted.value = true
})

watch(settingsOpen, (open) => {
  if (open) analyticsDraft.value = analyticsAllowed.value
})

function saveDraft() {
  setAnalyticsAllowed(analyticsDraft.value)
}
</script>

<template>
  <ClientOnly>
    <aside v-if="mounted && !hasCurrentConsent && !settingsOpen" class="cookie-banner" aria-label="Настройки cookies">
      <div class="cookie-banner__copy">
        <strong>Настройки cookies</strong>
        <p>Необходимые cookies обеспечивают работу Pocker. Аналитика необязательна и сейчас не подключена.</p>
        <NuxtLink to="/legal/cookies">Подробнее</NuxtLink>
      </div>
      <div class="cookie-banner__actions">
        <button class="btn" type="button" @click="setAnalyticsAllowed(true)">Принять аналитику</button>
        <button class="btn btn--ghost" type="button" @click="setAnalyticsAllowed(false)">Только необходимые</button>
        <button class="cookie-banner__settings" type="button" @click="openPreferences">Настройки cookies</button>
      </div>
    </aside>

    <div v-if="settingsOpen" class="cookie-dialog__backdrop" @click.self="closePreferences">
      <section class="cookie-dialog panel" role="dialog" aria-modal="true" aria-labelledby="cookie-dialog-title">
        <div class="cookie-dialog__heading">
          <div>
            <p class="eyebrow">Pocker / Privacy</p>
            <h2 id="cookie-dialog-title">Настройки cookies</h2>
          </div>
          <button class="cookie-dialog__close" type="button" aria-label="Закрыть настройки cookies" @click="closePreferences">×</button>
        </div>
        <p class="cookie-dialog__description">Выбор сохраняется для текущей версии Политики cookies. Необходимые cookies используются всегда для авторизации, безопасности и работы сервиса.</p>
        <label class="cookie-dialog__option">
          <span><strong>Необходимые</strong><small>Авторизация, сессия, безопасность и критичные настройки.</small></span>
          <input type="checkbox" checked disabled aria-label="Необходимые cookies всегда включены">
        </label>
        <label class="cookie-dialog__option">
          <span><strong>Аналитика</strong><small>Необязательная категория для будущего analytics provider. Сейчас внешние скрипты не загружаются.</small></span>
          <input v-model="analyticsDraft" type="checkbox" aria-label="Разрешить аналитику">
        </label>
        <div class="cookie-dialog__links">
          <NuxtLink to="/legal/cookies">Открыть Политику cookies</NuxtLink>
        </div>
        <div class="cookie-dialog__actions">
          <button class="btn" type="button" @click="saveDraft">Сохранить выбор</button>
          <button class="btn btn--ghost" type="button" @click="closePreferences">Отмена</button>
        </div>
      </section>
    </div>
  </ClientOnly>
</template>

<style scoped lang="scss">
.cookie-banner { position:fixed; z-index:40; right:1rem; bottom:calc(1rem + env(safe-area-inset-bottom,0px)); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:1rem; width:min(720px,calc(100vw - 2rem)); padding:1rem 1.1rem; border:1px solid rgba(242,180,81,.28); border-radius:18px; color:var(--text-primary); background:linear-gradient(145deg,rgba(26,65,46,.98),rgba(11,29,21,.98)); box-shadow:0 16px 50px rgba(0,0,0,.3); }
.cookie-banner__copy { min-width:0; }
.cookie-banner__copy p { margin:.35rem 0; color:var(--text-muted); font-size:.82rem; line-height:1.4; }
.cookie-banner__copy a,.cookie-banner__settings { color:var(--accent); font-size:.78rem; }
.cookie-banner__actions { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:.5rem; }
.cookie-banner__actions .btn { white-space:nowrap; }
.cookie-banner__settings { padding:.2rem; border:0; background:transparent; cursor:pointer; }
.cookie-dialog__backdrop { position:fixed; z-index:50; inset:0; display:grid; place-items:center; padding:1rem; background:rgba(0,0,0,.58); }
.cookie-dialog { width:min(560px,100%); padding:1.2rem; }
.cookie-dialog__heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
.cookie-dialog h2 { margin:.25rem 0 0; }
.cookie-dialog__close { border:0; color:var(--text-muted); background:transparent; font-size:1.6rem; line-height:1; cursor:pointer; }
.cookie-dialog__description { color:var(--text-muted); line-height:1.45; }
.cookie-dialog__option { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.85rem 0; border-top:1px solid rgba(255,255,255,.08); cursor:pointer; }
.cookie-dialog__option strong,.cookie-dialog__option small { display:block; }
.cookie-dialog__option small { max-width:440px; margin-top:.25rem; color:var(--text-muted); line-height:1.35; }
.cookie-dialog__option input { flex:none; width:1.15rem; height:1.15rem; accent-color:var(--accent); }
.cookie-dialog__links { margin-top:.7rem; }
.cookie-dialog__links a { color:var(--accent); font-size:.82rem; }
.cookie-dialog__actions { display:flex; flex-wrap:wrap; gap:.6rem; margin-top:1rem; }
@media (max-width:700px) { .cookie-banner { right:.65rem; bottom:calc(.65rem + env(safe-area-inset-bottom,0px)); grid-template-columns:1fr; width:calc(100vw - 1.3rem); } .cookie-banner__actions { justify-content:flex-start; } .cookie-banner__actions .btn { flex:1 1 auto; } }
</style>
