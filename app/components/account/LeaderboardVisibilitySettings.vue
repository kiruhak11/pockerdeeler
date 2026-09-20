<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { getHttpErrorMessage } from '~/utils/httpError'

const accountStore = useAccountStore()
const leaderboardVisible = ref(true)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const saved = ref(false)

async function load() {
  if (!accountStore.user) return
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<{ leaderboardVisible: boolean }>('/api/auth/leaderboard-visibility')
    leaderboardVisible.value = result.leaderboardVisible
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось загрузить настройку рейтингов')
  } finally { loading.value = false }
}

async function save(nextValue: boolean) {
  if (saving.value || !accountStore.user) return
  const previous = leaderboardVisible.value
  leaderboardVisible.value = nextValue
  saving.value = true
  error.value = ''
  try {
    const result = await $fetch<{ leaderboardVisible: boolean }>('/api/auth/leaderboard-visibility', { method: 'POST', body: { leaderboardVisible: nextValue } })
    leaderboardVisible.value = result.leaderboardVisible
    saved.value = true
    window.setTimeout(() => { saved.value = false }, 1600)
  } catch (cause) {
    leaderboardVisible.value = previous
    error.value = getHttpErrorMessage(cause, 'Не удалось сохранить настройку рейтингов')
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <section v-if="accountStore.user" class="panel leaderboard-visibility-settings" aria-labelledby="leaderboard-visibility-title">
    <div class="leaderboard-visibility-settings__heading"><span class="settings-card__index">03</span><div><h2 id="leaderboard-visibility-title">Видимость в рейтингах</h2><p>Управляет только публичным общим и сезонным рейтингом.</p></div></div>
    <p v-if="loading" class="leaderboard-visibility-settings__status">Загружаем настройку...</p>
    <label v-else class="setting-row"><span><strong>Показывать меня в рейтингах</strong><small>Если отключить, ваш аккаунт не будет отображаться в общем и сезонном рейтингах.</small></span><input :checked="leaderboardVisible" :disabled="saving" type="checkbox" role="switch" @change="save(($event.target as HTMLInputElement).checked)"></label>
    <p v-if="error" class="leaderboard-visibility-settings__error" role="alert">{{ error }}</p>
    <p v-if="saved" class="leaderboard-visibility-settings__saved" role="status">Сохранено</p>
  </section>
</template>

<style scoped lang="scss">
.leaderboard-visibility-settings { display: grid; gap: .8rem; padding: 1.15rem; }
.leaderboard-visibility-settings__heading { display: flex; gap: .8rem; align-items: flex-start; }
.leaderboard-visibility-settings h2, .leaderboard-visibility-settings p { margin: 0; }
.leaderboard-visibility-settings h2 { font-size: 1.15rem; }
.leaderboard-visibility-settings__heading p, .leaderboard-visibility-settings__status { margin-top: .25rem; color: var(--text-muted); }
.leaderboard-visibility-settings .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem .25rem; border-bottom: 1px solid rgba(255,255,255,.08); cursor: pointer; }
.leaderboard-visibility-settings strong, .leaderboard-visibility-settings small { display: block; }
.leaderboard-visibility-settings small { max-width: 560px; margin-top: .25rem; color: var(--text-muted); line-height: 1.35; }
.leaderboard-visibility-settings input { appearance: none; flex: none; width: 52px; height: 30px; padding: 3px; border: 0; border-radius: 999px; background: #ffffff1c; transition: .2s; }
.leaderboard-visibility-settings input::before { content: ''; display: block; width: 24px; height: 24px; border-radius: 50%; background: #c4cec8; transition: .2s; }
.leaderboard-visibility-settings input:checked { background: var(--success); }
.leaderboard-visibility-settings input:checked::before { transform: translateX(22px); background: white; }
.leaderboard-visibility-settings__error { color: var(--danger); }
.leaderboard-visibility-settings__saved { color: var(--success); }
</style>
