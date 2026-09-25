<script setup lang="ts">
const route = useRoute()
const items = [
  { to: '/', label: 'Главная', path: 'm3 10 9-7 9 7v10H3V10m6 10v-7h6v7' },
  { to: '/rooms', label: 'Столы', path: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' },
  { to: '/online/create', label: 'Создать', path: 'M12 5v14M5 12h14' },
  { to: '/leaderboard', label: 'Рейтинг', path: 'M4 19V5m0 14h16M8 16v-3m4 3V8m4 8V5' },
  { to: '/minigames', label: 'Мини-игры', path: 'M7 7h10v10H7zM4 4h3m10 0h3v3M4 20h3m10 0h3v-3' },
  { to: '/profile', label: 'Профиль', path: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2' }
]
</script>

<template>
  <nav class="bottom-nav" aria-label="Основная навигация">
    <NuxtLink v-for="item in items" :key="item.to" :to="item.to" :class="{ 'is-active': route.path === item.to || (item.to === '/online/create' && route.path === '/create') || (item.to === '/minigames' && route.path === '/crash') }" :aria-current="route.path === item.to ? 'page' : undefined">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="item.path" /></svg>
      <span>{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

<style scoped lang="scss">
.bottom-nav {
  position: fixed; z-index: 40; bottom: 0; left: 50%; transform: translateX(-50%);
  width: min(100%, 620px); display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
  padding: 0.45rem 0.6rem calc(0.45rem + env(safe-area-inset-bottom, 0px));
  border: 1px solid rgba(219, 237, 222, 0.16); border-bottom: 0; border-radius: 24px 24px 0 0;
  background: rgba(12, 28, 21, 0.97); box-shadow: 0 -10px 35px rgba(0, 0, 0, 0.22); backdrop-filter: blur(16px);
  a { min-width: 0; min-height: 52px; display: grid; justify-items: center; align-content: center; gap: 0.25rem; color: var(--text-muted); text-decoration: none; border-radius: 14px; font-size: clamp(.6rem, 2.5vw, .78rem); line-height: 1.05; }
  span { display: block; max-width: 100%; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  svg { width: 22px; height: 22px; }
  a.is-active { color: var(--accent); background: rgba(242, 180, 81, 0.1); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
}
@media (max-width: 390px) {
  .bottom-nav { padding-inline: .3rem; }
  .bottom-nav a { min-height: 49px; font-size: .58rem; gap: .15rem; }
  .bottom-nav svg { width: 20px; height: 20px; }
}
</style>
