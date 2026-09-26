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

function isActive(to: string) {
  if (to === '/') return route.path === '/'
  if (to === '/online/create') return route.path === to || route.path === '/create'
  if (to === '/minigames') return route.path.startsWith('/minigames') || route.path === '/crash'
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <nav class="bottom-nav" aria-label="Основная навигация">
    <NuxtLink v-for="item in items" :key="item.to" :to="item.to" :class="{ 'is-active': isActive(item.to) }" :aria-current="isActive(item.to) ? 'page' : undefined">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="item.path" /></svg>
      <span>{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

<style scoped lang="scss">
.bottom-nav {
  position: fixed; z-index: 40; bottom: 0; left: 50%; transform: translateX(-50%);
  width: min(100%, 640px); display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
  padding: 0.45rem max(.55rem, env(safe-area-inset-right, 0px)) calc(0.45rem + env(safe-area-inset-bottom, 0px)) max(.55rem, env(safe-area-inset-left, 0px));
  border: 1px solid rgba(219, 237, 222, 0.16); border-bottom: 0; border-radius: 24px 24px 0 0;
  background: rgba(12, 28, 21, 0.97); box-shadow: 0 -10px 35px rgba(0, 0, 0, 0.22); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  a { min-width: 0; min-height: 54px; display: grid; justify-items: center; align-content: center; gap: 0.28rem; color: var(--text-muted); text-decoration: none; border-radius: 14px; font-size: clamp(.62rem, 2.5vw, .78rem); line-height: 1.05; transition: color .18s ease, background .18s ease, transform .18s ease; }
  span { display: block; max-width: 100%; overflow: hidden; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  svg { width: 22px; height: 22px; }
  a.is-active { color: var(--accent); background: linear-gradient(180deg, rgba(242, 180, 81, 0.14), rgba(242, 180, 81, 0.06)); }
  a:active { transform: scale(.96); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
}
@media (max-width: 390px) {
  .bottom-nav { padding-right: max(.25rem, env(safe-area-inset-right, 0px)); padding-left: max(.25rem, env(safe-area-inset-left, 0px)); }
  .bottom-nav a { min-height: 50px; font-size: .6rem; gap: .18rem; }
  .bottom-nav svg { width: 21px; height: 21px; }
}
@media (prefers-reduced-motion: reduce) { .bottom-nav a { transition: none; } }
</style>
