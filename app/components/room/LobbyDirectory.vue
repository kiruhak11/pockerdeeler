<script setup lang="ts">
import { getHttpErrorMessage } from '~/utils/httpError'
import AppIcon from '~/components/ui/AppIcon.vue'

const tab = ref<'public' | 'private'>('public')
const { data: rooms, status, error, refresh } = await useFetch('/api/rooms')
const visible = computed(() => (rooms.value || []).filter(r => r.hasPassword === (tab.value === 'private')))
const policy = { mixed: 'Аккаунты и гости', accounts: 'С аккаунтами', guests: 'Гостевой стол' }
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { if (!document.hidden) void refresh() }, 15_000) })
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <section class="panel lobby-directory" aria-labelledby="lobbies-title">
    <header>
      <div><span class="lobby-directory__eyebrow">КАТАЛОГ</span><h2 id="lobbies-title">Столы прямо сейчас</h2><p class="page-subtitle">Состояние обновляется автоматически каждые 15 секунд.</p></div>
      <button class="lobby-directory__refresh" :disabled="status === 'pending'" aria-label="Обновить комнаты" @click="refresh()">↻</button>
    </header>
    <div class="lobby-directory__tabs" aria-label="Доступ к комнатам">
      <button :class="{ active: tab === 'public' }" :aria-pressed="tab === 'public'" @click="tab = 'public'"><span>Открытые</span><small>Вход без пароля</small></button>
      <button :class="{ active: tab === 'private' }" :aria-pressed="tab === 'private'" @click="tab = 'private'"><span>Закрытые</span><small>Доступ по паролю</small></button>
    </div>
    <p v-if="error" role="alert">{{ getHttpErrorMessage(error, 'Не удалось загрузить комнаты. Попробуйте обновить список.') }}</p>
    <p v-else-if="!rooms && status === 'pending'">Ищем комнаты...</p>
    <p v-else-if="!visible.length" class="page-subtitle">Здесь пока нет столов. Создайте свою комнату и пригласите друзей.</p>
    <div class="lobby-directory__grid">
      <article v-for="room in visible" :key="room.code">
        <div class="lobby-card__top"><span class="lobby-card__status" :class="{ live: room.status !== 'lobby' }"><i />{{ room.status === 'lobby' ? 'Сбор игроков' : 'Игра идёт' }}</span><strong class="lobby-card__code">{{ room.code }}</strong></div>
        <div><h3>{{ room.name }}</h3><p>{{ policy[room.playerPolicy] }}</p></div>
        <div class="lobby-card__facts"><span><small>Игроки</small><strong>{{ room.playerCount }}/{{ room.maxPlayers }}</strong></span><span><small>Блайнды</small><strong>{{ room.smallBlind }}/{{ room.bigBlind }}</strong></span><span><small>Доступ</small><strong>{{ room.hasPassword ? 'Пароль' : 'Свободно' }}</strong></span></div>
        <NuxtLink class="lobby-card__join" :to="`/room/${room.code}/join`">Занять место <AppIcon name="arrow-right" :size="16" /></NuxtLink>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
.lobby-directory {
  display: grid; gap: 1rem; padding: 1.1rem;
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  h2, h3 { margin: 0; }
  &__eyebrow { display: block; margin-bottom: .3rem; color: var(--accent); font-size: .66rem; font-weight: 900; letter-spacing: .14em; }
  &__refresh { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; color: var(--text-primary); background: rgba(255,255,255,.04); font-size: 1.4rem; cursor: pointer; }
  &__tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .3rem; border-radius: 18px; background: rgba(0,0,0,.2); button { display: grid; gap: .15rem; padding: .65rem .8rem; border: 1px solid transparent; border-radius: 14px; color: var(--text-muted); background: transparent; cursor: pointer; text-align: left; } button.active { border-color: rgba(242,180,81,.3); color: var(--text-primary); background: rgba(242,180,81,.11); } small { font-size: .7rem; } }
  &__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 0.8rem; }
  article { position: relative; overflow: hidden; padding: 1rem; display: grid; gap: 1rem; border: 1px solid rgba(255,255,255,.1); border-radius: 20px; background: linear-gradient(145deg, #173b2b, #0e2119); &::after { content: ''; position: absolute; width: 110px; height: 110px; right: -65px; top: -60px; border-radius: 50%; background: rgba(242,180,81,.1); } }
  p { margin: 0; color: var(--text-muted); }
}
.lobby-card__top { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.lobby-card__status { display: inline-flex; align-items: center; gap: .4rem; color: var(--text-muted); font-size: .72rem; font-weight: 700; i { width: 7px; height: 7px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px rgba(90,196,130,.1); } &.live i { background: var(--accent); } }
.lobby-card__code { position: relative; z-index: 1; color: var(--accent); font-size: .8rem; letter-spacing: .12em; }
.lobby-card__facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: .4rem; span { display: grid; gap: .1rem; padding: .5rem; border-radius: 12px; background: rgba(0,0,0,.18); } small { color: var(--text-muted); font-size: .62rem; } strong { font-size: .82rem; } }
.lobby-card__join { display: flex; justify-content: space-between; align-items: center; padding: .75rem .85rem; border-radius: 14px; color: #132018; background: var(--accent); font-weight: 900; text-decoration: none; }
@media (max-width: 600px) { .lobby-directory { padding: .8rem; } .lobby-directory__tabs button { text-align: center; } }
</style>
