<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { getHttpErrorMessage } from '~/utils/httpError'

const accountStore = useAccountStore()
const categories = [
  { key: 'NICKNAME', title: 'Ник', description: 'Ваш игровой ник в публичных списках.' },
  { key: 'GAME_STATISTICS', title: 'Игровая статистика', description: 'Игры, победы, серии и связанные показатели.' },
  { key: 'ACHIEVEMENTS', title: 'Достижения', description: 'Полученные достижения и выбранный значок.' },
  { key: 'VIRTUAL_BALANCE', title: 'Виртуальный баланс', description: 'Баланс фишек в публичных рейтингах.' },
  { key: 'RATING', title: 'Рейтинг', description: 'Рейтинг игры и рейтинг прогнозов.' },
  { key: 'WIN_HISTORY', title: 'История побед', description: 'Публичные данные о победах, если они отображаются.' }
] as const
type Category = typeof categories[number]['key']

const selected = ref<Category[]>([])
const documentVersion = ref('1.0')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const saved = ref(false)

async function load() {
  if (!accountStore.user) return
  loading.value = true
  try {
    const result = await $fetch<{ categories: Category[]; documentVersion: string }>('/api/auth/personal-data-distribution')
    selected.value = result.categories.filter(category => categories.some(item => item.key === category))
    documentVersion.value = result.documentVersion
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось загрузить настройки публичности')
  } finally { loading.value = false }
}

function toggle(category: Category, enabled: boolean) {
  selected.value = enabled ? [...new Set([...selected.value, category])] : selected.value.filter(item => item !== category)
  void save()
}

async function save() {
  if (saving.value || !accountStore.user) return
  saving.value = true
  error.value = ''
  try {
    const result = await $fetch<{ categories: Category[]; documentVersion: string }>('/api/auth/personal-data-distribution', { method: 'POST', body: { categories: selected.value } })
    selected.value = result.categories
    documentVersion.value = result.documentVersion
    saved.value = true
    window.setTimeout(() => { saved.value = false }, 1600)
  } catch (cause) { error.value = getHttpErrorMessage(cause, 'Не удалось сохранить настройки публичности')
  } finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <section v-if="accountStore.user" class="panel distribution-settings" aria-labelledby="distribution-settings-title">
    <div class="distribution-settings__heading"><span class="settings-card__index">05</span><div><h2 id="distribution-settings-title">Публичность данных</h2><p>Вы сами выбираете, какие данные разрешаете показывать публично.</p></div></div>
    <p class="distribution-settings__legal"><NuxtLink to="/legal/personal-data-distribution" target="_blank">Согласие на распространение данных</NuxtLink><span>Версия {{ documentVersion }}</span></p>
    <p v-if="loading" class="distribution-settings__status">Загружаем настройки...</p>
    <div v-else class="settings-list">
      <label v-for="item in categories" :key="item.key" class="setting-row"><span><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span><input :checked="selected.includes(item.key)" type="checkbox" role="switch" :disabled="saving" @change="toggle(item.key, ($event.target as HTMLInputElement).checked)"></label>
    </div>
    <p v-if="error" class="distribution-settings__error" role="alert">{{ error }}</p>
    <p v-if="saved" class="distribution-settings__saved" role="status">Сохранено</p>
  </section>
</template>

<style scoped lang="scss">
.distribution-settings { display: grid; gap: .8rem; padding: 1.15rem; }
.distribution-settings__heading { display: flex; gap: .8rem; align-items: flex-start; }
.distribution-settings h2, .distribution-settings p { margin: 0; }
.distribution-settings h2 { font-size: 1.15rem; }
.distribution-settings__heading p, .distribution-settings__status { margin-top: .25rem; color: var(--text-muted); }
.distribution-settings__legal { display: flex; flex-wrap: wrap; gap: .55rem .8rem; align-items: center; font-size: .78rem; }
.distribution-settings__legal a { color: var(--accent); }
.distribution-settings__legal span { color: var(--text-muted); }
.distribution-settings .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem .25rem; border-bottom: 1px solid rgba(255,255,255,.08); cursor: pointer; }
.distribution-settings .setting-row:last-child { border-bottom: 0; }
.distribution-settings strong, .distribution-settings small { display: block; }
.distribution-settings small { max-width: 560px; margin-top: .25rem; color: var(--text-muted); line-height: 1.35; }
.distribution-settings input { appearance: none; flex: none; width: 52px; height: 30px; padding: 3px; border: 0; border-radius: 999px; background: #ffffff1c; transition: .2s; }
.distribution-settings input::before { content: ''; display: block; width: 24px; height: 24px; border-radius: 50%; background: #c4cec8; transition: .2s; }
.distribution-settings input:checked { background: var(--success); }
.distribution-settings input:checked::before { transform: translateX(22px); background: white; }
.distribution-settings__error { color: var(--danger); }
.distribution-settings__saved { color: var(--success); }
</style>
