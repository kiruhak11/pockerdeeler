<script setup lang="ts">
import { legalDocuments } from '~/data/legalDocuments'
const { openPreferences } = useCookieConsent()

const featuredSlugs = ['offer', 'privacy', 'game-rules', 'requisites']
const featuredDocuments = featuredSlugs
  .map(slug => legalDocuments.find(document => document.slug === slug))
  .filter((document): document is (typeof legalDocuments)[number] => Boolean(document))
</script>

<template>
  <footer class="legal-footer">
    <div class="legal-footer__inner">
      <div><strong>Poker Dealer Desk</strong><small>Виртуальные фишки · внутри платформы</small></div>
      <nav aria-label="Юридические документы">
        <NuxtLink to="/legal">Документы</NuxtLink>
        <NuxtLink v-for="document in featuredDocuments" :key="document.slug" :to="`/legal/${document.slug}`">{{ document.shortTitle }}</NuxtLink>
        <button class="legal-footer__settings" type="button" @click="openPreferences">Настройки cookies</button>
      </nav>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.legal-footer { padding:1.5rem 1rem calc(7rem + env(safe-area-inset-bottom,0px)); border-top:1px solid rgba(255,255,255,.08); background:rgba(7,23,17,.52); }
.legal-footer__inner { display:flex; justify-content:space-between; align-items:flex-start; gap:1.5rem; max-width:1200px; margin:auto; }
.legal-footer strong, .legal-footer small { display:block; }
.legal-footer strong { color:#dce9df; font:700 .9rem 'Space Grotesk',sans-serif; }
.legal-footer small { margin-top:.35rem; color:var(--text-muted); font-size:.72rem; }
.legal-footer nav { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.45rem .8rem; max-width:680px; }
.legal-footer a { color:var(--text-muted); font-size:.72rem; text-decoration:none; }
.legal-footer__settings { padding:0; border:0; color:var(--text-muted); font:inherit; font-size:.72rem; background:transparent; cursor:pointer; }
.legal-footer a:hover, .legal-footer a:focus-visible, .legal-footer__settings:hover, .legal-footer__settings:focus-visible { color:var(--accent); outline:none; }
@media (max-width:700px) { .legal-footer__inner { display:grid; gap:1rem; } .legal-footer nav { justify-content:flex-start; } }
</style>
