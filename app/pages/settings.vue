<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import AccountSecuritySettings from '~/components/account/AccountSecuritySettings.vue'

const accountStore = useAccountStore()
const { loadMe, changePassword } = useAccountAuth()
const { editablePreferences, load, save, reset } = useGamePreferences()
const saved = ref(false)
const loading = ref(false)
const error = ref('')
const success = ref('')
const telegram = ref<{ isActive: boolean; username?: string | null; firstName?: string | null } | null>(null)
const telegramBusy = ref(false)
const telegramPreferences = reactive<Record<string, boolean>>({ purchases: true, premium: true, friends: true, games: true, achievements: true, seasons: true, adminChanges: true })
const telegramPreferenceLabels: Record<string, string> = { purchases: 'Покупки и возвраты', premium: 'Premium', friends: 'Друзья', games: 'Игры и приглашения', achievements: 'Достижения', seasons: 'Сезоны', adminChanges: 'Административные изменения' }
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const options: { key: Exclude<keyof typeof editablePreferences, 'actionLanguage'>; title: string; description: string }[] = [
  { key: 'notifications', title: 'Игровые уведомления', description: 'Общие сообщения о важных событиях игры.' },
  { key: 'chatToasts', title: 'Сообщения чата', description: 'Показывать короткие уведомления о новых сообщениях.' },
  { key: 'turnVibration', title: 'Вибрация при ходе', description: 'Телефон вибрирует, когда очередь переходит к вам.' },
  { key: 'turnAutoScroll', title: 'Автопрокрутка к действиям', description: 'Плавно показывать панель ставки в начале вашего хода.' },
  { key: 'revealModals', title: 'Модалки открытия карт', description: 'Показывать крупные подсказки при переходе к флопу, тёрну и риверу.' },
  { key: 'handResultModals', title: 'Итог раздачи', description: 'Показывать на три секунды результат победы или поражения.' },
  { key: 'handsGuide', title: 'Кнопка комбинаций', description: 'Показывать кнопку «?» в правом нижнем углу игрового стола.' }
]

onMounted(async () => {
  load()
  accountStore.loadSession()
  if (accountStore.token && !accountStore.user) await loadMe().catch(() => undefined)
  if (accountStore.user) await $fetch<{ settings: Record<string, boolean> }>('/api/telegram/preferences').then(result => Object.assign(telegramPreferences, result.settings)).catch(() => undefined)
  window.addEventListener('focus', refreshTelegram)
  document.addEventListener('visibilitychange', refreshTelegram)
})
let telegramRefreshPending = false
let telegramRevision = 0
async function refreshTelegram() {
  if (!accountStore.user || telegramBusy.value || telegramRefreshPending || document.visibilityState === 'hidden') return
  telegramRefreshPending = true
  const revision = telegramRevision
  try { const state = await $fetch<typeof telegram.value>('/api/telegram/status'); if (revision === telegramRevision) telegram.value = state }
  catch (cause) { error.value = getHttpErrorMessage(cause, 'Не удалось проверить привязку Telegram') }
  finally { telegramRefreshPending = false }
}
watch(() => accountStore.user?.id, () => { if (import.meta.client) void refreshTelegram() }, { immediate: true })
onUnmounted(() => { window.removeEventListener('focus', refreshTelegram); document.removeEventListener('visibilitychange', refreshTelegram) })

function showSaved() {
  saved.value = true
  window.setTimeout(() => { saved.value = false }, 1600)
}

function persist() { save(); showSaved() }
function setActionLanguage(language: 'ru' | 'en') { editablePreferences.actionLanguage = language; persist() }
function resetAll() { reset(); showSaved() }
async function saveTelegramPreferences() {
  try { const result = await $fetch<{ settings: Record<string, boolean> }>('/api/telegram/preferences', { method: 'POST', body: { settings: { ...telegramPreferences } } }); Object.assign(telegramPreferences, result.settings); showSaved() }
  catch (cause) { error.value = getHttpErrorMessage(cause, 'Не удалось сохранить категории Telegram') }
}

async function connectTelegram() {
  telegramBusy.value = true
  try {
    const result = await $fetch<{ url: string }>('/api/telegram/link', { method: 'POST' })
    window.location.href = result.url
  } catch (cause) { error.value = getHttpErrorMessage(cause, 'Не удалось создать ссылку Telegram') }
  finally { telegramBusy.value = false }
}

async function disconnectTelegram() {
  ++telegramRevision
  telegramBusy.value = true
  try {
    await $fetch('/api/telegram/unlink', { method: 'POST' })
    telegram.value = { isActive: false }
    success.value = 'Telegram отвязан'
  } catch (cause) { error.value = getHttpErrorMessage(cause, 'Не удалось отвязать Telegram') }
  finally { telegramBusy.value = false }
}

async function onChangePassword() {
  error.value = ''
  success.value = ''
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    error.value = 'Подтверждение пароля не совпадает'
    return
  }
  loading.value = true
  try {
    await changePassword(passwordForm.currentPassword, passwordForm.newPassword)
    await loadMe()
    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    success.value = 'Пароль успешно изменён'
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось изменить пароль')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="page-shell settings-page">
    <header class="settings-hero">
      <p class="eyebrow">Личный кабинет</p>
      <h1 class="page-title">Настройки</h1>
      <p class="page-subtitle">Ваш темп игры, подсказки и безопасность аккаунта.</p>
      <nav class="settings-tabs"><NuxtLink to="/profile">Профиль</NuxtLink><NuxtLink class="is-active" to="/settings">Настройки</NuxtLink></nav>
    </header>

    <section class="panel settings-card settings-card--language">
      <div><span class="settings-card__index">01</span><h2>Язык игровых кнопок</h2><p>Меняется только подпись действий. Правила и расчёты остаются прежними.</p></div>
      <div class="language-switch" role="group" aria-label="Язык игровых действий">
        <button type="button" :class="{ active: editablePreferences.actionLanguage === 'ru' }" @click="setActionLanguage('ru')"><strong>Русский</strong><small>Чек · Поддержать · Повысить</small></button>
        <button type="button" :class="{ active: editablePreferences.actionLanguage === 'en' }" @click="setActionLanguage('en')"><strong>English</strong><small>Check · Call · Raise</small></button>
      </div>
    </section>

    <section class="panel settings-card">
      <div class="settings-card__heading"><span class="settings-card__index">02</span><div><h2>Игровой интерфейс</h2><p>Настройки сохраняются только на этом устройстве.</p></div></div>
      <div class="settings-list">
        <label v-for="option in options" :key="option.key" class="setting-row"><span><strong>{{ option.title }}</strong><small>{{ option.description }}</small></span><input v-model="editablePreferences[option.key]" type="checkbox" role="switch" @change="persist"></label>
      </div>
    </section>

    <AccountSecuritySettings />

    <section v-if="accountStore.user" class="panel settings-card telegram-settings-card">
      <div class="settings-card__heading"><span class="settings-card__index">04</span><div><h2>Telegram</h2><p>Уведомления и привязка управляются только здесь.</p></div></div>
      <div v-if="telegram?.isActive" class="telegram-settings-card__connected"><span><strong>Telegram подключён</strong><small>{{ telegram.username ? `@${telegram.username}` : telegram.firstName || 'Чат привязан' }}</small></span><button class="btn btn--ghost" type="button" :disabled="telegramBusy" @click="disconnectTelegram">Отвязать Telegram</button></div>
      <button v-else class="btn" type="button" :disabled="telegramBusy" @click="connectTelegram">{{ telegramBusy ? 'Создаём ссылку...' : 'Подключить Telegram' }}</button>
      <div v-if="telegram?.isActive" class="telegram-preferences"><h3>Категории уведомлений</h3><label v-for="(enabled, category) in telegramPreferences" :key="category" class="setting-row"><span><strong>{{ telegramPreferenceLabels[category] }}</strong><small>Получать значимые события этой категории в Telegram.</small></span><input v-model="telegramPreferences[category]" type="checkbox" role="switch" @change="saveTelegramPreferences"></label></div>
    </section>

    <div class="settings-actions"><button class="btn btn--ghost" type="button" @click="resetAll">Вернуть настройки по умолчанию</button><span v-if="saved" role="status">Сохранено</span></div>
  </main>
</template>

<style scoped lang="scss">
.settings-page { display: grid; gap: 1rem; max-width: 880px; padding-top: 1.4rem; }
.settings-hero { padding: 1.5rem; border: 1px solid rgba(242,180,81,.2); border-radius: 28px; background: radial-gradient(circle at 95% 0, rgba(242,180,81,.15), transparent 35%), linear-gradient(145deg, rgba(26,65,46,.95), rgba(11,29,21,.96)); }
.settings-tabs { display: inline-flex; gap: .25rem; margin-top: .8rem; padding: .25rem; border-radius: 999px; background: rgba(255,255,255,.06); a { padding: .55rem .9rem; border-radius: 999px; color: var(--text-muted); text-decoration: none; } a.is-active { color: #142119; background: var(--accent); font-weight: 800; } }
.settings-card { display: grid; gap: 1rem; padding: 1.15rem; h2, p { margin: 0; } h2 { font-size: 1.15rem; } p { color: var(--text-muted); } &__heading { display: flex; gap: .8rem; align-items: flex-start; } &__index { display: inline-grid; place-items: center; min-width: 2rem; height: 2rem; border-radius: 10px; color: var(--accent); background: rgba(242,180,81,.1); font-size: .72rem; font-weight: 900; } }
.settings-card--language { grid-template-columns: minmax(0, .75fr) minmax(320px, 1.25fr); align-items: center; }
.language-switch { display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem; padding: .3rem; border-radius: 18px; background: rgba(0,0,0,.22); button { display: grid; gap: .2rem; min-height: 78px; padding: .8rem; border: 1px solid transparent; border-radius: 14px; color: var(--text-muted); background: transparent; cursor: pointer; text-align: left; } button.active { border-color: rgba(242,180,81,.45); color: var(--text-primary); background: linear-gradient(135deg, rgba(242,180,81,.2), rgba(242,180,81,.07)); } small { font-size: .72rem; } }
.settings-list { display: grid; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem .25rem; border-bottom: 1px solid rgba(255,255,255,.08); cursor: pointer; &:last-child { border-bottom: 0; } strong, small { display: block; } small { max-width: 560px; margin-top: .25rem; color: var(--text-muted); line-height: 1.35; } input { appearance: none; flex: none; width: 52px; height: 30px; padding: 3px; border: 0; border-radius: 999px; background: #ffffff1c; transition: .2s; &::before { content: ''; display: block; width: 24px; height: 24px; border-radius: 50%; background: #c4cec8; transition: .2s; } &:checked { background: var(--success); } &:checked::before { transform: translateX(22px); background: white; } } }
.password-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .65rem; label { display: grid; gap: .35rem; color: var(--text-muted); font-size: .82rem; } }
.security-card__notice { padding: .7rem; border-radius: 12px; color: var(--accent) !important; background: rgba(242,180,81,.09); }
.security-card__submit { justify-self: start; }
.telegram-settings-card__connected { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.8rem 1rem; border-radius:14px; color:var(--success); background:rgba(67,181,129,.12); strong,.telegram-settings-card__connected small { display:block; } small { margin-top:.2rem; color:var(--text-muted); } }
.message { padding: .65rem; border-radius: 12px; &--error { color: var(--danger) !important; background: rgba(229,88,88,.08); } &--success { color: var(--success) !important; background: rgba(90,196,130,.08); } }
.settings-actions { display: flex; align-items: center; gap: 1rem; span { color: var(--success); } }
@media (max-width: 700px) { .settings-page { padding-top: .65rem; } .settings-hero { padding: 1.1rem; border-radius: 22px; } .settings-card--language { grid-template-columns: 1fr; } .language-switch { grid-template-columns: 1fr; } .password-grid { grid-template-columns: 1fr; } .settings-actions { align-items: stretch; flex-direction: column; } }
</style>
