<script setup lang="ts">
import PwaDialog from './PwaDialog.vue'
const { state, dismissInstall } = usePwa()
const copied = ref(false)
const copyFailed = ref(false)
// Never copy account credentials, invitation secrets, query parameters or fragments.
const installUrl = computed(() => import.meta.client ? window.location.origin + '/' : '/')
async function copyLink() {
  try {
    await navigator.clipboard.writeText(installUrl.value)
    copied.value = true
    copyFailed.value = false
  } catch { copyFailed.value = true }
}
function install() { window.dispatchEvent(new Event('poker:install')) }
</script>

<template>
  <PwaDialog title="Добавьте игру на экран Домой" @close="dismissInstall()">
    <div class="pwa-brand"><img src="/pwa/icon-192.png" width="64" height="64" alt=""><p>Ваш покерный стол в одно касание, без поиска вкладки. Установка необязательна.</p></div>
    <template v-if="state.ios">
      <p v-if="!state.safari">Откройте сайт в Safari. Во встроенном браузере ищите «Открыть в Safari» или «Открыть в браузере» в меню. Если такого пункта нет, скопируйте ссылку и вставьте её в Safari.</p>
      <ol class="pwa-steps">
        <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>В Safari откройте меню дополнительных действий, если кнопка «Поделиться» не видна.</li>
        <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M7 10H4v11h16V10h-3"/></svg>Нажмите «Поделиться». В другой компоновке Safari эта кнопка находится прямо на панели.</li>
        <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7v10M7 12h10"/></svg>Выберите «На экран Домой». Если пункта нет, прокрутите вниз до «Изменить действия» и добавьте его.</li>
        <li>При наличии включите «Открывать как веб-приложение», затем нажмите «Добавить».</li>
      </ol>
      <a href="https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios" target="_blank" rel="noopener noreferrer">Инструкция Apple</a>
    </template>
    <template v-else>
      <p v-if="state.embedded">Откройте ссылку во внешнем браузере через его меню или скопируйте её.</p>
      <p v-if="state.canPrompt">Этот браузер поддерживает установку. Кнопка ниже откроет настоящее предложение браузера.</p>
      <p v-else>Откройте меню браузера и найдите «Установить приложение» или «Добавить на главный экран». Если такого пункта нет, продолжайте играть в браузере.</p>
      <button v-if="state.canPrompt" type="button" class="btn" @click="install">Установить приложение</button>
    </template>
    <p class="pwa-note">Safari и приложение могут потребовать отдельный вход. Используйте тот же аккаунт и вернитесь в свою комнату; не создавайте новое место. Онлайн-игре нужен интернет.</p>
    <button v-if="state.embedded || (state.ios && !state.safari)" type="button" class="btn btn--ghost" @click="copyLink">{{ copied ? 'Ссылка скопирована' : 'Скопировать ссылку сайта' }}</button>
    <p v-if="copyFailed" role="status">Скопируйте адрес вручную: <input :value="installUrl" readonly aria-label="Адрес сайта" @focus="($event.target as HTMLInputElement).select()"></p>
    <p v-if="state.message" role="status">{{ state.message }}</p>
    <div class="pwa-actions">
      <button type="button" class="btn" @click="dismissInstall()">Позже, продолжить игру</button>
      <button type="button" class="btn btn--ghost" @click="dismissInstall(true)">Больше не показывать</button>
    </div>
  </PwaDialog>
</template>

<style scoped>
.pwa-brand { display: flex; align-items: center; gap: 14px; }
.pwa-brand img { border-radius: 15px; flex-shrink: 0; }
.pwa-brand p { margin: 0; }
.pwa-steps { padding-left: 25px; }
.pwa-steps li { padding: 0 0 14px 5px; }
svg { width: 24px; height: 24px; fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; vertical-align: middle; margin-right: 6px; }
.pwa-note { color: var(--text-muted); font-size: .9rem; }
input { width: 100%; }
</style>
