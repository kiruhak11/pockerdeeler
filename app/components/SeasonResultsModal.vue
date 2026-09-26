<script setup lang="ts">
import AppIcon from '~/components/ui/AppIcon.vue'
defineProps<{ summary: any }>()
const emit = defineEmits<{ close: [] }>()
const format = (value: unknown) => Number(value || 0).toLocaleString('ru-RU')
</script>

<template>
  <Teleport to="body">
    <div class="season-backdrop" @click.self="emit('close')">
      <section class="season-modal" role="dialog" aria-modal="true" aria-labelledby="season-result-title">
        <button class="season-modal__close" aria-label="Закрыть" @click="emit('close')">×</button>
        <AppIcon class="season-modal__icon" name="trophy" :size="48"/>
        <small>СЕЗОН ЗАВЕРШЁН</small>
        <h2 id="season-result-title">Итоги сезона {{ summary?.seasonNumber }}</h2>
        <div class="season-modal__stats">
          <article><strong>{{ format(summary?.snapshot?.balance) }}</strong><span>фишек заработано</span></article>
          <article><strong>{{ format(summary?.snapshot?.tableRating) }}</strong><span>рейтинг стола</span></article>
          <article><strong>{{ format(summary?.snapshot?.predictionRating) }}</strong><span>рейтинг прогнозов</span></article>
          <article><strong>{{ format(summary?.snapshot?.handsPlayed) }}</strong><span>раздач сыграно</span></article>
        </div>
        <div class="season-rewards">
          <article v-for="reward in summary?.rewards || []" :key="reward.id">
            <AppIcon :name="reward.icon" :size="26"/><div><small>СЕЗОННАЯ НАГРАДА</small><strong>{{ reward.title }}</strong><p>{{ reward.description }}</p></div>
          </article>
        </div>
        <div class="season-modal__next"><span>Сезон {{ Number(summary?.seasonNumber || 0) + 1 }} начался</span><b>50 000 фишек · рейтинги 1 000</b><small>Обычные достижения и игровая статистика начаты заново.</small></div>
        <div class="season-modal__actions"><NuxtLink class="btn" to="/profile" @click="emit('close')">Открыть в профиле</NuxtLink><button class="btn btn--ghost" @click="emit('close')">Продолжить</button></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.season-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:1rem;background:rgba(0,0,0,.76);backdrop-filter:blur(8px);overscroll-behavior:contain}
.season-modal{position:relative;display:grid;gap:.85rem;width:min(100%,560px);max-height:calc(100dvh - 2rem - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));overflow:auto;padding:2rem;border:1px solid rgba(242,180,81,.4);border-radius:28px;color:var(--text-primary);background:radial-gradient(circle at 90% 0,rgba(242,180,81,.2),transparent 38%),linear-gradient(145deg,#173f2d,#091d15);box-shadow:0 30px 90px #000d;overscroll-behavior:contain}
.season-modal__close{position:absolute;right:1rem;top:.8rem;border:0;background:transparent;color:var(--text-muted);font-size:2rem;cursor:pointer}.season-modal__icon{font-size:3rem}.season-modal>small{color:var(--accent);font-weight:900;letter-spacing:.14em}.season-modal h2{margin:0;font-size:clamp(1.7rem,6vw,2.5rem)}
.season-modal__stats{display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem}.season-modal__stats article{display:grid;padding:.75rem;border-radius:14px;background:#ffffff0a}.season-modal__stats strong{font-size:1.25rem;color:var(--accent)}.season-modal__stats span{font-size:.75rem;color:var(--text-muted)}
.season-rewards{display:grid;gap:.5rem}.season-rewards article{display:flex;gap:.8rem;align-items:center;padding:.85rem;border:1px solid rgba(242,180,81,.22);border-radius:16px;background:rgba(242,180,81,.08)}.season-rewards article>span{font-size:2rem}.season-rewards strong,.season-rewards small{display:block}.season-rewards small{color:var(--accent);font-size:.62rem;font-weight:900;letter-spacing:.08em}.season-rewards p{margin:.18rem 0 0;color:var(--text-muted);font-size:.75rem}
.season-modal__next{display:grid;gap:.15rem;padding:.85rem 1rem;border-radius:14px;background:rgba(255,255,255,.05);color:var(--text-muted)}.season-modal__next b{color:var(--accent);font-size:1.15rem}.season-modal__next small{font-size:.72rem}.season-modal__actions{display:flex;gap:.5rem;flex-wrap:wrap}
@media(max-width:600px){.season-backdrop{align-items:end;padding:0 max(.35rem,env(safe-area-inset-right,0px)) 0 max(.35rem,env(safe-area-inset-left,0px))}.season-modal{width:100%;max-height:min(90dvh,900px);padding:1.25rem 1rem calc(1rem + env(safe-area-inset-bottom,0px));border-radius:26px 26px 0 0}.season-modal__close{top:.55rem;right:.55rem;width:44px;height:44px}.season-modal__stats{grid-template-columns:repeat(2,minmax(0,1fr))}.season-modal__actions{display:grid;grid-template-columns:1fr 1fr}.season-modal__actions>*{display:flex;align-items:center;justify-content:center;min-height:46px;text-align:center}}
</style>
