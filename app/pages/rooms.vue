<script setup lang="ts">
import LobbyDirectory from '~/components/room/LobbyDirectory.vue'
import ReservedRooms from '~/components/room/ReservedRooms.vue'
import OnlineLobbyDirectory from '~/components/room/OnlineLobbyDirectory.vue'
useHead({ title: 'Столы | Poker Dealer Desk' })

const mode = ref<'HOME' | 'ONLINE'>('ONLINE')
</script>

<template>
  <main class="page-shell rooms-page">
    <header class="rooms-hero"><div><span class="rooms-page__eyebrow">ЖИВЫЕ КОМНАТЫ</span><h1 class="page-title">Выберите свой стол</h1><p class="page-subtitle">Вернитесь к друзьям или начните новую игру за пару минут.</p></div><NuxtLink class="rooms-hero__create" :to="mode === 'ONLINE' ? '/online/create' : '/create'"><span>＋</span><strong>{{ mode === 'ONLINE' ? 'Создать онлайн-стол' : 'Создать домашний стол' }}</strong><small>{{ mode === 'ONLINE' ? 'Пригласить игроков по коду' : 'Настроить свою игру' }}</small></NuxtLink></header>
    <nav class="rooms-mode-switch" aria-label="Тип стола">
      <button type="button" :class="{ active: mode === 'ONLINE' }" :aria-pressed="mode === 'ONLINE'" @click="mode = 'ONLINE'">Онлайн</button>
      <button type="button" :class="{ active: mode === 'HOME' }" :aria-pressed="mode === 'HOME'" @click="mode = 'HOME'">С реальными картами</button>
    </nav>
    <template v-if="mode === 'HOME'">
      <ReservedRooms />
      <LobbyDirectory />
    </template>
    <OnlineLobbyDirectory v-else />
  </main>
</template>

<style scoped lang="scss">
.rooms-page { display: grid; gap: 1rem; padding-top: 1.35rem; }
.rooms-mode-switch { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .3rem; border: 1px solid rgba(255,255,255,.1); border-radius: 18px; background: rgba(0,0,0,.18); }
.rooms-mode-switch button { min-height: 46px; border: 1px solid transparent; border-radius: 14px; color: var(--text-muted); background: transparent; cursor: pointer; font-weight: 700; }
.rooms-mode-switch button.active { border-color: rgba(242,180,81,.3); color: var(--text-primary); background: rgba(242,180,81,.11); }
.rooms-page__eyebrow { display: block; color: var(--accent); letter-spacing: 0.18em; font-size: 0.7rem; margin-bottom: 0.65rem; }
.rooms-hero { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.35rem; border: 1px solid rgba(242,180,81,.2); border-radius: 28px; background: radial-gradient(circle at 75% 0, rgba(242,180,81,.17), transparent 32%), linear-gradient(135deg, #174631, #0d251b); }
.rooms-hero__create { min-width: 230px; display: grid; grid-template-columns: auto 1fr; gap: .05rem .7rem; align-items: center; padding: .8rem 1rem; border: 1px solid rgba(242,180,81,.3); border-radius: 18px; color: var(--text-primary); background: rgba(8,22,15,.45); text-decoration: none; span { grid-row: 1 / 3; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; color: #172116; background: var(--accent); font-size: 1.4rem; } small { color: var(--text-muted); } }
@media (max-width: 700px) { .rooms-page { padding-top: .65rem; } .rooms-hero { display: grid; padding: 1rem; border-radius: 22px; } .rooms-hero__create { min-width: 0; } }
</style>
