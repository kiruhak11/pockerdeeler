<script setup lang="ts">
import type { Player } from '~/types/game'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'
const props = defineProps<{ player: Player | null }>()
const emit = defineEmits<{ close: [] }>()
const statusLabels: Record<string, string> = { waiting: 'Ожидает раздачу', active: 'В игре', checked: 'Check', folded: 'Fold', 'all-in': 'All-in', winner: 'Победитель', out: 'Выбыл' }
</script>
<template>
  <Teleport to="body"><div v-if="player" class="player-profile-modal" role="dialog" aria-modal="true" :aria-label="`Профиль игрока ${player.name}`" @click.self="emit('close')"><article>
    <button class="player-profile-modal__close" type="button" aria-label="Закрыть" @click="emit('close')">×</button>
    <div class="player-profile-modal__avatar"><AchievementBadge v-if="player.achievementIcon" :code="player.achievementIcon" :size="58"/><span v-else>{{ player.name.slice(0, 1).toUpperCase() }}</span></div>
    <h2>{{ player.name }} <small v-if="player.premiumType === 'PREMIUM'">Premium</small></h2>
    <span class="tag">{{ statusLabels[player.status] || player.status }}</span>
    <div class="player-profile-modal__stats"><p><strong>{{ player.stack.toLocaleString('ru-RU') }}</strong><span>стек</span></p><p><strong>{{ player.tableRating?.toLocaleString('ru-RU') || '—' }}</strong><span>рейтинг игры</span></p><p><strong>{{ player.predictionRating?.toLocaleString('ru-RU') || '—' }}</strong><span>рейтинг прогнозов</span></p><p><strong>{{ player.achievementCount ?? 0 }}</strong><span>достижений</span></p></div>
    <div v-if="player.achievementIcons?.length" class="player-profile-modal__achievements"><span v-for="(icon, index) in player.achievementIcons" :key="`${icon}-${index}`"><AchievementBadge :code="icon" :size="26"/></span></div>
    <p v-else class="player-profile-modal__empty">Достижений пока нет</p>
  </article></div></Teleport>
</template>
<style scoped lang="scss">
.player-profile-modal { position: fixed; inset: 0; z-index: 1250; display: grid; place-items: center; padding: 1rem; background: #020c08c7; backdrop-filter: blur(5px); article { position: relative; width: min(440px, 100%); padding: 1.3rem; border: 1px solid rgba(242,180,81,.38); border-radius: 24px; background: radial-gradient(circle at 50% 0, #284936, #10231a 58%); text-align: center; box-shadow: 0 30px 90px #000a; } h2 { margin: .65rem 0 .4rem; } h2 small { padding: .2rem .45rem; border-radius: 999px; color: #172116; background: var(--accent); font-size: .62rem; vertical-align: middle; } }
.player-profile-modal__close { position: absolute; top: .7rem; right: .7rem; width: 42px; height: 42px; border: 1px solid #ffffff24; border-radius: 50%; color: inherit; background: transparent; font-size: 1.5rem; }
.player-profile-modal__avatar { display: grid; place-items: center; width: 74px; height: 74px; margin: 0 auto; border: 2px solid var(--accent); border-radius: 50%; background: #1d3729; font: 800 2rem 'Space Grotesk', sans-serif; }
.player-profile-modal__stats { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: 1rem; p { display: grid; gap: .15rem; margin: 0; padding: .65rem; border-radius: var(--radius-md); background: #ffffff0a; } strong { color: var(--accent); } span { color: var(--text-muted); font-size: .72rem; } }
.player-profile-modal__achievements { display: flex; flex-wrap: wrap; justify-content: center; gap: .4rem; margin-top: .8rem; span { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: rgba(242,180,81,.12); } }
.player-profile-modal__empty { color: var(--text-muted); }
@media (max-width: 600px) {
  .player-profile-modal { align-items: end; padding: 0 max(.35rem,env(safe-area-inset-right,0px)) 0 max(.35rem,env(safe-area-inset-left,0px)); }
  .player-profile-modal article { width: 100%; max-height: 88dvh; overflow-y: auto; padding: 1.25rem 1rem calc(1rem + env(safe-area-inset-bottom,0px)); border-radius: 24px 24px 0 0; overscroll-behavior: contain; }
  .player-profile-modal__close { top: .65rem; right: .65rem; }
  .player-profile-modal__stats { gap: .4rem; }
}
</style>
