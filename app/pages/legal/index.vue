<script setup lang="ts">
import { legalDocuments } from '~/data/legalDocuments'
import AppIcon from '~/components/ui/AppIcon.vue'

useHead({
  title: 'Юридическая информация · Poker Dealer Desk',
  meta: [{ name: 'description', content: 'Публичные юридические документы Pocker.' }]
})
</script>

<template>
  <main class="legal-index page-shell">
    <nav class="legal-breadcrumbs" aria-label="Навигация по юридическим документам">
      <NuxtLink to="/">Главная</NuxtLink>
      <span aria-hidden="true">/</span>
      <span>Юридическая информация</span>
    </nav>
    <header class="legal-index__hero">
      <p class="eyebrow">POKER DEALER DESK / LEGAL</p>
      <h1 class="page-title">Юридическая информация</h1>
      <p class="page-subtitle">Публичные документы Pocker, их версии и даты вступления в силу.</p>
    </header>
    <section class="legal-catalog" aria-labelledby="legal-catalog-title">
      <h2 id="legal-catalog-title">Документы</h2>
      <div class="legal-catalog__grid">
        <NuxtLink v-for="document in legalDocuments" :key="document.slug" class="legal-card" :to="`/legal/${document.slug}`">
          <span class="legal-card__title">{{ document.shortTitle }}</span>
          <span class="legal-card__summary">{{ document.summary }}</span>
          <span class="legal-card__meta">Версия {{ document.version }} · действует с {{ document.effectiveDate }}</span>
          <span class="legal-card__action">Открыть документ <AppIcon name="arrow-right" :size="14" /></span>
        </NuxtLink>
      </div>
    </section>
  </main>
</template>

<style scoped lang="scss">
.legal-index { max-width:1100px; padding-top:1.5rem; padding-bottom:3rem; }
.legal-breadcrumbs { display:flex; gap:.55rem; align-items:center; margin-bottom:1.25rem; color:var(--text-muted); font-size:.78rem; }
.legal-breadcrumbs a { color:var(--accent); text-decoration:none; }
.legal-index__hero { padding:clamp(1.25rem,4vw,2.5rem); border:1px solid rgba(242,180,81,.22); border-radius:var(--radius-lg); background:linear-gradient(135deg,rgba(32,66,50,.92),rgba(18,34,27,.96)); box-shadow:0 20px 60px rgba(0,0,0,.16); }
.eyebrow { margin:0 0 .75rem; color:#9bc2ae; font-size:.68rem; letter-spacing:.16em; }
.legal-index__hero .page-title { font-size:clamp(1.8rem,5vw,3rem); }
.legal-index__hero .page-subtitle { max-width:680px; line-height:1.55; }
.legal-catalog { margin-top:1.25rem; }
.legal-catalog h2 { margin:0 0 .8rem; color:#f0d28b; font:700 1.2rem/1.25 'Space Grotesk',sans-serif; }
.legal-catalog__grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.8rem; }
.legal-card { display:grid; gap:.55rem; min-width:0; padding:1.05rem 1.15rem; border:1px solid rgba(255,255,255,.09); border-radius:var(--radius-md); color:inherit; text-decoration:none; background:linear-gradient(145deg,rgba(26,40,34,.88),rgba(17,27,23,.92)); transition:border-color .2s ease, transform .2s ease; }
.legal-card:hover, .legal-card:focus-visible { border-color:rgba(242,180,81,.5); transform:translateY(-1px); outline:none; }
.legal-card__title { color:#f0d28b; font:700 1rem/1.3 'Space Grotesk',sans-serif; }
.legal-card__summary { color:#c2d1c8; font-size:.86rem; line-height:1.5; }
.legal-card__meta { color:var(--text-muted); font-size:.72rem; }
.legal-card__action { color:var(--accent); font-size:.78rem; }
@media (max-width:700px) { .legal-index { padding-top:.8rem; } .legal-catalog__grid { grid-template-columns:1fr; } .legal-breadcrumbs { font-size:.7rem; } }
</style>
