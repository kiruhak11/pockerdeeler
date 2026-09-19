<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { AchievementResponse, AchievementView } from '~/types/achievement'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'

const account = useAccountStore()
const { loadMe } = useAccountAuth()
const achievements = ref<AchievementView[]>([])
const loading = ref(true)
const error = ref('')
const selectedCode = ref<string | null>(null)
const unlockedCount = computed(() => achievements.value.filter(item => item.unlocked).length)
const rarityOrder: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }
const sortedAchievements = computed(() => [...achievements.value].sort((a, b) => Number(Boolean(b.seasonal)) - Number(Boolean(a.seasonal)) || (rarityOrder[a.rarity] ?? 99) - (rarityOrder[b.rarity] ?? 99) || a.title.localeCompare(b.title, 'ru')))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const user = await loadMe()
    if (!user) return
    const response = await $fetch<AchievementResponse>('/api/auth/achievements')
    achievements.value = response.achievements
    selectedCode.value = response.selectedCode
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось загрузить достижения')
  } finally {
    loading.value = false
  }
}

async function selectIcon(item: AchievementView) {
  if (!item.unlocked) return
  const code = selectedCode.value === item.code ? null : item.code
  try {
    await $fetch('/api/auth/achievements/select', { method: 'POST', body: { code } })
    selectedCode.value = code
    if (account.user) account.user.selectedAchievementCode = code
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось выбрать иконку')
  }
}

onMounted(load)
</script>

<template>
  <main class="page-shell achievements-page">
    <header class="achievements-page__header">
      <div><p class="eyebrow">Коллекция игрока</p><h1 class="page-title">Достижения</h1><p class="page-subtitle">Полученные награды дают фишки и рейтинг. Одну иконку можно поставить после ника.</p></div>
      <div class="achievement-progress"><strong>{{ unlockedCount }}/{{ achievements.length || 18 }}</strong><span>получено</span></div>
    </header>

    <p v-if="error" class="achievements-page__error" role="alert">{{ error }}</p>
    <p v-if="loading">Загружаем достижения...</p>
    <section v-else-if="!account.user" class="panel"><p>Войдите в аккаунт, чтобы видеть прогресс и выбирать иконку.</p><NuxtLink class="btn" to="/login">Войти</NuxtLink></section>
    <section v-else class="achievements-catalog">
      <button v-for="item in sortedAchievements" :key="item.code" type="button" class="achievement-tile" :class="{ 'achievement-tile--locked': !item.unlocked, 'achievement-tile--unlocked': item.unlocked, 'achievement-tile--seasonal': item.seasonal, 'achievement-tile--selected': selectedCode === item.code }" :disabled="!item.unlocked" @click="selectIcon(item)">
        <span class="achievement-tile__icon"><AchievementBadge :code="item.code" :size="48"/></span>
        <span class="achievement-tile__body"><span class="achievement-tile__top"><strong>{{ item.title }}</strong><small>{{ item.seasonal ? `Сезон ${item.seasonNumber}` : item.rarity }}</small></span><span>{{ item.description }}</span><small v-if="item.seasonal">Редкость: {{ item.rarity }}</small><small v-else>+{{ item.ratingReward }} рейтинга · +{{ item.moneyReward.toLocaleString('ru-RU') }} фишек</small><small v-if="item.unlockedAt">Получено {{ new Date(item.unlockedAt).toLocaleDateString('ru-RU') }}</small><small v-else>Еще не получено</small></span>
        <span v-if="selectedCode === item.code" class="achievement-tile__selected">Выбрано</span>
      </button>
    </section>
  </main>
</template>

<style scoped lang="scss">
.achievements-page { display: grid; gap: 1rem; }
.achievements-page__header { display: flex; justify-content: space-between; align-items: end; gap: 1rem; }
.achievement-progress { min-width: 110px; padding: .8rem; border: 1px solid rgba(242,180,81,.45); border-radius: var(--radius-lg); text-align: center; background: rgba(242,180,81,.08); }
.achievement-progress strong, .achievement-progress span { display: block; }
.achievement-progress strong { color: var(--accent); font-size: 1.6rem; }
.achievement-progress span { color: var(--text-muted); font-size: .75rem; }
.achievements-catalog { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: .75rem; }
.achievement-tile { position: relative; display: grid; grid-template-columns: 3rem 1fr; gap: .8rem; min-height: 132px; padding: 1rem; border: 1px solid rgba(255,255,255,.12); border-radius: var(--radius-lg); color: var(--text-primary); background: rgba(22,35,30,.92); text-align: left; cursor: pointer; }
.achievement-tile--locked { filter: grayscale(1); opacity: .48; cursor: default; }
.achievement-tile--unlocked { border-color: rgba(242,180,81,.8); background: linear-gradient(135deg, rgba(242,180,81,.15), rgba(22,35,30,.95)); }
.achievement-tile--seasonal { border-color: rgba(190,130,255,.85); background: linear-gradient(135deg, rgba(133,73,196,.28), rgba(22,35,30,.95)); box-shadow: inset 0 0 28px rgba(133,73,196,.08); }
.achievement-tile--selected { border-color: var(--success); background: linear-gradient(135deg, rgba(90,196,130,.2), rgba(22,35,30,.95)); box-shadow: 0 0 0 1px var(--success); }
.achievement-tile__icon { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 50%; background: rgba(255,255,255,.08); font-size: 1.7rem; }
.achievement-tile__body, .achievement-tile__body > span, .achievement-tile__body > small { display: block; }
.achievement-tile__body > span:not(.achievement-tile__top), .achievement-tile__body > small { margin-top: .35rem; color: var(--text-muted); font-size: .78rem; }
.achievement-tile__top { display: flex !important; justify-content: space-between; gap: .5rem; }
.achievement-tile__top small { color: var(--accent); text-transform: uppercase; font-size: .65rem; }
.achievement-tile__selected { position: absolute; right: .7rem; bottom: .6rem; color: var(--success); font-size: .7rem; font-weight: 800; }
.achievements-page__error { color: var(--danger); }
@media (max-width: 700px) { .achievements-page__header { align-items: stretch; flex-direction: column; } .achievement-progress { align-self: stretch; } .achievements-catalog { grid-template-columns: 1fr; } .achievement-tile { min-height: 118px; padding: .85rem; } }
</style>
