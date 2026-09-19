<script setup lang="ts">
import { getLegalDocument, legalDocuments } from '~/data/legalDocuments'

const route = useRoute()
const document = getLegalDocument(String(route.params.slug))
if (!document) {
  throw createError({ statusCode: 404, statusMessage: 'Юридический документ не найден' })
}

useHead(() => ({
  title: `${document?.title || 'Юридический документ'} · Poker Dealer Desk`,
  meta: [{ name: 'description', content: document?.summary || 'Юридическая информация Poker Dealer Desk' }]
}))

const otherDocuments = legalDocuments.filter(item => item.slug !== document?.slug)
</script>

<template>
  <main v-if="document" class="legal-page page-shell">
    <nav class="legal-breadcrumbs" aria-label="Навигация по юридическим документам"><NuxtLink to="/">Главная</NuxtLink><span>→</span><span>Юридическая информация</span></nav>
    <header class="legal-hero">
      <p class="eyebrow">POKER DEALER DESK / LEGAL</p>
      <h1 class="page-title">{{ document.title }}</h1>
      <p class="page-subtitle">{{ document.summary }}</p>
      <div class="legal-meta"><span>Версия {{ document.version }}</span><span>Действует с {{ document.effectiveDate }}</span></div>
    </header>
    <article class="legal-document">
      <section v-for="section in document.sections" :key="section.heading" class="legal-section">
        <h2>{{ section.heading }}</h2>
        <p v-for="paragraph in section.paragraphs || []" :key="paragraph">{{ paragraph }}</p>
        <ul v-if="section.items?.length"><li v-for="item in section.items" :key="item">{{ item }}</li></ul>
      </section>
    </article>
    <aside class="legal-updated"><strong>Версия документа: {{ document.version }}</strong><span>Дата вступления в силу: {{ document.effectiveDate }}</span><small>При изменении публикуется новая версия; опубликованные версии не перезаписываются.</small></aside>
    <nav class="legal-related" aria-label="Другие юридические документы"><NuxtLink v-for="item in otherDocuments" :key="item.slug" :to="`/legal/${item.slug}`">{{ item.shortTitle }} <span>↗</span></NuxtLink></nav>
  </main>
</template>

<style scoped lang="scss">
.legal-page { max-width: 940px; padding-top: 1.5rem; padding-bottom: 3rem; }
.legal-breadcrumbs { display:flex; gap:.55rem; align-items:center; margin-bottom:1.25rem; color:var(--text-muted); font-size:.78rem; }
.legal-breadcrumbs a { color:var(--accent); text-decoration:none; }
.legal-hero { padding:clamp(1.25rem,4vw,2.5rem); border:1px solid rgba(242,180,81,.22); border-radius:var(--radius-lg); background:linear-gradient(135deg,rgba(32,66,50,.92),rgba(18,34,27,.96)); box-shadow:0 20px 60px rgba(0,0,0,.16); }
.eyebrow { margin:0 0 .75rem; color:#9bc2ae; font-size:.68rem; letter-spacing:.16em; }
.legal-hero .page-title { font-size:clamp(1.8rem,5vw,3rem); }
.legal-hero .page-subtitle { max-width:680px; line-height:1.55; }
.legal-meta { display:flex; flex-wrap:wrap; gap:.6rem; margin-top:1.35rem; }
.legal-meta span { padding:.4rem .65rem; border:1px solid rgba(255,255,255,.12); border-radius:999px; color:#dce9e0; font-size:.74rem; background:rgba(255,255,255,.05); }
.legal-document { display:grid; gap:1rem; margin-top:1rem; }
.legal-section { padding:clamp(1rem,3vw,1.45rem); border:1px solid rgba(255,255,255,.08); border-radius:var(--radius-md); background:linear-gradient(145deg,rgba(26,40,34,.88),rgba(17,27,23,.92)); }
.legal-section h2 { margin:0 0 .85rem; color:#f0d28b; font:700 1.05rem/1.25 'Space Grotesk',sans-serif; }
.legal-section p, .legal-section li { color:#c2d1c8; font-size:.92rem; line-height:1.7; }
.legal-section p { margin:.65rem 0 0; }
.legal-section p:first-of-type { margin-top:0; }
.legal-section ul { display:grid; gap:.55rem; margin:.65rem 0 0; padding-left:1.25rem; }
.legal-section li::marker { color:var(--accent); }
.legal-updated { display:grid; gap:.3rem; margin-top:1rem; padding:1rem 1.2rem; border-left:3px solid var(--accent); color:var(--text-muted); background:rgba(242,180,81,.06); font-size:.78rem; }
.legal-updated strong { color:var(--text-primary); }
.legal-related { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:1rem; }
.legal-related a { padding:.65rem .8rem; border:1px solid rgba(255,255,255,.1); border-radius:12px; color:#d9e5dd; text-decoration:none; font-size:.78rem; background:rgba(255,255,255,.04); }
.legal-related a:hover, .legal-related a:focus-visible { border-color:rgba(242,180,81,.5); color:var(--accent); outline:none; }
@media (max-width:560px) { .legal-page { padding-top:.8rem; } .legal-breadcrumbs { font-size:.7rem; } .legal-section p, .legal-section li { font-size:.86rem; line-height:1.62; } .legal-related { display:grid; grid-template-columns:1fr 1fr; } .legal-related a { min-width:0; } }
</style>
