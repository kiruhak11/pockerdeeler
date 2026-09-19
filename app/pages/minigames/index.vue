<script setup lang="ts">
import AnimatedChips from '~/components/minigames/AnimatedChips.vue'
import GameArtwork from '~/components/minigames/GameArtwork.vue'
import AppIcon from '~/components/ui/AppIcon.vue'
const route = useRoute()
if (['rocket','mines','jackpot'].includes(String(route.query.game))) await navigateTo(`/minigames/${route.query.game}`, { replace: true })
const { data, error, countdown } = useMiniGameLobby()
useHead({ title: 'Мини-игры · Poker Dealer Desk' })
</script>
<template>
  <main class="arcade">
    <header class="arcade-heading"><div><p class="arcade-eyebrow">POKER DEALER DESK / PLAY</p><h1>Маленькие игры.<br><span>Большие моменты.</span></h1></div><span class="live-pill" :class="{ offline:error }"><i/>{{ error ? 'Обновляем связь' : 'LIVE' }}</span></header>
    <section class="jackpot-banner" aria-label="Текущий общий джекпот"><div class="banner-glow"/><div><p class="arcade-eyebrow">ОБЩИЙ ДЖЕКПОТ <span v-if="data?.season">· СЕЗОН {{ data.season.number }}</span></p><div class="jackpot-value"><AnimatedChips :value="data?.jackpot"/><span>фишек</span></div><p class="muted">Пополняется проигрышами в мини-играх.<br>Три призовых места — в следующем сезоне.</p></div><div class="banner-emblem" aria-hidden="true">♛<span>SEASON PRIZE POOL</span></div></section>
    <div class="section-label"><span>Выбери свою игру</span><span>Только виртуальные фишки</span></div>
    <div class="arcade-cards">
      <NuxtLink to="/minigames/rocket" class="arcade-card rocket-card"><div class="card-copy"><p class="arcade-eyebrow">01 / CRASH GAME</p><h2>Ракетка<AppIcon class="arcade-arrow" name="arrow-right" :size="20"/></h2><p>Поймай свой икс.<br>Забери до взрыва.</p><div class="card-bottom"><small>ОСТАЛОСЬ НА СЕГОДНЯ</small><strong><AnimatedChips :value="data?.rocketBank"/><span>фишек</span></strong><div class="bank-track"><i :style="{ width: Math.min(100,(data?.rocketBank ?? 0)/50000)+'%' }"/></div><small v-if="data?.rocketBank===0">Дневной банк исчерпан · выигрыши выплачиваются</small></div></div><GameArtwork kind="rocket"/><span class="card-enter">Играть <b><AppIcon name="arrow-right" :size="16"/></b></span></NuxtLink>
      <NuxtLink to="/minigames/mines" class="arcade-card mines-card"><div class="card-copy"><p class="arcade-eyebrow">02 / MINES GAME</p><h2>Мины<AppIcon class="arcade-arrow" name="arrow-right" :size="20"/></h2><p>За каждой клеткой — выбор.<br>За смелостью — награда.</p><div class="card-bottom"><small>ОСТАЛОСЬ НА СЕГОДНЯ</small><strong><AnimatedChips :value="data?.minesBank"/><span>фишек</span></strong><div class="bank-track"><i :style="{ width: Math.min(100,(data?.minesBank ?? 0)/20000)+'%' }"/></div><small v-if="data?.minesBank===0">Дневной банк исчерпан · выигрыши выплачиваются</small></div></div><GameArtwork kind="mines"/><span class="card-enter">Открыть поле <b><AppIcon name="arrow-right" :size="16"/></b></span></NuxtLink>
      <NuxtLink to="/minigames/jackpot" class="arcade-card gold-card"><div class="card-copy"><p class="arcade-eyebrow">03 / SEASON JACKPOT</p><h2>Джекпот<AppIcon class="arcade-arrow" name="arrow-right" :size="20"/></h2><p>Этот сезон ещё удивит.<br>Три места. Три больших приза.</p><div class="card-bottom"><small>ДО КОНЦА СЕЗОНА</small><strong class="countdown">{{ countdown }}</strong><small>{{ data?.participants.length ?? '—' }} участников · итоги после перехода сезона</small></div></div><GameArtwork kind="jackpot"/><span class="card-enter">К призам <b><AppIcon name="arrow-right" :size="16"/></b></span></NuxtLink>
    </div>
    <p class="arcade-note">Банки и джекпот обновляются в реальном времени. Играйте в своём темпе.</p>
  </main>
</template>
<style src="~/assets/css/arcade.css"/>
