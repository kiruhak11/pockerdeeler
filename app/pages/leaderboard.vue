<script setup lang="ts">
import type { LeaderboardEntry, LeaderboardSort } from '~/types/leaderboard'
import type { PremiumAccess } from '~/types/premium'
import AppIcon from '~/components/ui/AppIcon.vue'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'

const sort = ref<LeaderboardSort>('rating')
const entries = ref<LeaderboardEntry[]>([])
const loading = ref(false)
const error = ref('')
const premiumAccess = ref<PremiumAccess | null>(null)
const premiumOnly = ref(false)
const seasonCategory = ref('tableRating')
const seasonCategories = [
  { key: 'balance', label: 'Баланс' }, { key: 'tableRating', label: 'Рейтинг' }, { key: 'predictionWins', label: 'Прогнозы' },
  { key: 'predictionPayout', label: 'Ставки' }, { key: 'bestWinStreak', label: 'Серия' }, { key: 'winRate', label: 'Надёжность' }, { key: 'handsPlayed', label: 'Активность' }
]
const filters: { key: LeaderboardSort; label: string; short: string; icon: string }[] = [
  { key: 'rating', label: 'Рейтинг игры', short: 'Рейтинг', icon: '♠' },
  { key: 'balance', label: 'Баланс', short: 'Баланс', icon: '◉' },
  { key: 'wins', label: 'Успешные прогнозы', short: 'Прогнозы', icon: '✓' },
  { key: 'achievements', label: 'Достижения', short: 'Награды', icon: '◆' },
  { key: 'streak', label: 'Серия побед', short: 'Серия', icon: 'arrow-right' }
  ,{ key: 'season', label: 'Сезон', short: 'Сезон', icon: 'trophy' }
]

async function load() {
  loading.value = true
  error.value = ''
  try { entries.value = sort.value === 'season' ? (await $fetch<any>('/api/season/leaderboard', { query: { category: seasonCategory.value } })).entries.map((item: any) => ({ ...item, wins: item.wins ?? item.handsWon, predictions: item.predictions ?? item.predictionCount, successPercent: item.successPercent ?? item.winRate, streak: item.streak ?? 0, bestStreak: item.bestStreak ?? item.bestWinStreak })) : (await $fetch<{ entries: LeaderboardEntry[] }>('/api/leaderboard', { query: { sort: sort.value, premiumOnly: premiumOnly.value || undefined } })).entries }
  catch { error.value = 'Не удалось загрузить лидерборд' }
  finally { loading.value = false }
}
function mainLabel(entry: LeaderboardEntry) {
  if (sort.value === 'season') {
    const label = seasonCategories.find(category => category.key === seasonCategory.value)?.label || 'Показатель'
    return `${entry.value === undefined ? '—' : entry.value.toLocaleString('ru-RU')} ${label.toLowerCase()}`
  }
  if (sort.value === 'balance' && entry.balance !== undefined) return `${entry.balance.toLocaleString('ru-RU')} баланс`
  if (sort.value === 'wins' && entry.predictionWins !== undefined) return `${entry.predictionWins} точных прогнозов`
  if (sort.value === 'streak' && entry.streak !== undefined) return `${entry.streak} подряд`
  if (sort.value === 'achievements' && entry.achievements !== undefined) return `${entry.achievements} достижений`
  return `${entry.tableRating ?? '—'} рейтинг игры`
}
watch([sort, seasonCategory, premiumOnly], load)
onMounted(async () => { try { premiumAccess.value = await $fetch<PremiumAccess>('/api/premium/me') } catch {} await load() })
</script>

<template>
  <main class="page-shell leaderboard-page">
    <header class="leaderboard-hero"><p class="leaderboard-hero__eyebrow">ЗАЛ СЛАВЫ</p><h1 class="page-title">Лидерборд</h1><p class="page-subtitle">Сравнивайте мастерство за столом, серии и прогресс, а не только размер кошелька.</p></header>
    <nav class="leaderboard-tabs" aria-label="Сортировка лидерборда">
      <button v-for="filter in filters" :key="filter.key" :class="{ active: sort === filter.key }" :aria-pressed="sort === filter.key" @click="sort = filter.key"><i><AppIcon v-if="filter.icon === 'arrow-right'" name="arrow-right" :size="20"/><template v-else>{{ filter.icon }}</template></i><span>{{ filter.label }}</span><small>{{ filter.short }}</small></button>
    </nav>
    <nav v-if="sort === 'season'" class="season-categories" aria-label="Категории сезона"><button v-for="category in seasonCategories" :key="category.key" :class="{ active: seasonCategory === category.key }" @click="seasonCategory = category.key">{{ category.label }}</button></nav>
    <label v-if="sort !== 'season' && premiumAccess?.features.includes('LEADERBOARD_PREMIUM_FILTER')" class="premium-filter"><input v-model="premiumOnly" type="checkbox"><span>Показать только Premium</span></label>
    <p v-if="loading">Загружаем рейтинг...</p><p v-if="error" class="leaderboard-page__error">{{ error }}</p>
    <section v-if="!loading" class="panel leaderboard-list">
      <div v-for="entry in entries" :key="entry.userId || entry.rank" class="leaderboard-row" :class="{ 'leaderboard-row--podium': entry.rank <= 3 }">
        <strong class="leaderboard-row__rank"><AppIcon v-if="entry.rank <= 3" :name="['medal-gold','medal-silver','medal-bronze'][entry.rank - 1]" :size="22"/><span v-else>#{{ entry.rank }}</span></strong>
        <span class="leaderboard-row__name"><span class="leaderboard-row__username">{{ entry.username }}</span><span v-if="entry.selectedAchievementIcon" class="leaderboard-row__badge"><AchievementBadge :code="entry.selectedAchievementIcon" :size="18"/></span></span>
        <strong class="leaderboard-row__main">{{ mainLabel(entry) }}</strong>
      </div>
      <p v-if="!entries.length" class="page-subtitle">Пока нет данных для рейтинга.</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.leaderboard-page { display: grid; gap: 1rem; padding-top: 1.35rem; }
.leaderboard-hero { padding: 1.35rem; border: 1px solid rgba(242,180,81,.2); border-radius: 28px; background: radial-gradient(circle at 88% 0, rgba(242,180,81,.18), transparent 38%), linear-gradient(135deg, #183f2d, #0c2118); }
.leaderboard-hero__eyebrow { margin: 0 0 .5rem; color: var(--accent); font-size: .68rem; font-weight: 900; letter-spacing: .18em; }
.leaderboard-tabs { display: grid; grid-template-columns: repeat(5, 1fr); gap: .4rem; padding: .35rem; border-radius: 20px; background: rgba(0,0,0,.2); button { display: grid; justify-items: center; gap: .2rem; min-height: 72px; padding: .55rem .3rem; border: 1px solid transparent; border-radius: 16px; color: var(--text-muted); background: transparent; cursor: pointer; } i { display: grid; place-items: center; width: 24px; height: 24px; color: var(--accent); font-style: normal; } small { display: none; } .active { border-color: rgba(242,180,81,.3); color: var(--text-primary); background: linear-gradient(145deg, rgba(242,180,81,.18), rgba(242,180,81,.06)); } }
.leaderboard-list { display: grid; gap: .4rem; padding: .55rem; }
.season-categories{display:flex;gap:.4rem;overflow-x:auto;padding:.2rem;scrollbar-width:none}.season-categories button{flex:none;padding:.55rem .8rem;border:1px solid rgba(255,255,255,.1);border-radius:999px;color:var(--text-muted);background:rgba(255,255,255,.04);cursor:pointer}.season-categories button.active{border-color:rgba(242,180,81,.5);color:#152018;background:var(--accent);font-weight:800}
.premium-filter{display:flex;align-items:center;gap:.55rem;width:max-content;padding:.55rem .8rem;border:1px solid rgba(242,180,81,.25);border-radius:999px;color:var(--text-muted);background:rgba(242,180,81,.06);font-size:.8rem;cursor:pointer}.premium-filter input{accent-color:var(--accent)}
.leaderboard-row { display: grid; grid-template-columns: 3rem minmax(130px, 1fr) auto; gap: .8rem; align-items: center; padding: .9rem .8rem; border: 1px solid transparent; border-radius: 15px; color: var(--text-muted); background: rgba(255,255,255,.025); }
.leaderboard-row--podium { border-color: rgba(242,180,81,.11); background: linear-gradient(90deg, rgba(242,180,81,.09), rgba(255,255,255,.02)); }
.leaderboard-row__name { display: inline-flex; min-width: 0; align-items: center; gap: .35rem; overflow: hidden; color: var(--text); font-weight: 800; white-space: nowrap; }
.leaderboard-row__username { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leaderboard-row__badge { display: inline-flex; flex: 0 0 auto; line-height: 0; }
.leaderboard-row__main { color: var(--accent); text-align: right; white-space: nowrap; }
.table-record__wins { color: #72d395; }
.table-record__losses { color: #ff8b82; }
.leaderboard-page__error { color: var(--danger); }
@media (max-width: 700px) {
  .leaderboard-page { padding-top: .65rem; }
  .leaderboard-hero { padding: 1rem; border-radius: 22px; }
  .leaderboard-tabs { grid-template-columns: repeat(6, minmax(64px, 1fr)); overflow-x: auto; scroll-snap-type: x mandatory; button { scroll-snap-align: start; min-width: 64px; min-height: 64px; } button span { display: none; } button small { display: block; font-size: .62rem; } }
  .leaderboard-row { grid-template-columns: 2.3rem 1fr; gap: .45rem; padding: .8rem .35rem; }
  .leaderboard-row__main { grid-column: 2 / 3; justify-self: start; font-size: .82rem; text-align: left; white-space: normal; }
  .leaderboard-row__rank { align-self: start; }
}
</style>
