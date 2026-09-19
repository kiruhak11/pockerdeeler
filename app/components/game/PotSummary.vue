<script setup lang="ts">
defineProps<{
  pot: number
  currentBet: number
  handNumber: number
  smallBlind?: number
  bigBlind?: number
  currentPlayerName?: string | null
}>()
</script>

<template>
  <section class="panel pot-focus">
    <div class="pot-focus__main"><span>Банк раздачи</span><strong>{{ pot.toLocaleString('ru-RU') }}</strong><small>Раздача #{{ handNumber }}</small></div>
    <div class="pot-focus__facts"><span><small>Ставка стола</small><strong>{{ currentBet.toLocaleString('ru-RU') }}</strong></span><span v-if="smallBlind && bigBlind"><small>Блайнды</small><strong>{{ smallBlind }}/{{ bigBlind }}</strong></span></div>
    <div class="pot-focus__turn"><i /><span>Сейчас ходит</span><strong>{{ currentPlayerName || 'Ожидаем раздачу' }}</strong></div>
  </section>
</template>

<style scoped lang="scss">
.pot-focus { position: relative; overflow: hidden; display: grid; grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr); align-items: stretch; gap: .65rem; padding: .8rem; border-color: rgba(242,180,81,.24); background: radial-gradient(circle at 15% 30%, rgba(242,180,81,.13), transparent 32%), rgba(10,28,19,.94); &::after { content: ''; position: absolute; inset: auto -30% -65% 30%; height: 100px; border-radius: 50%; background: rgba(43,117,78,.12); filter: blur(20px); } }
.pot-focus__main { position: relative; z-index: 1; display: grid; align-content: center; padding: .55rem .7rem; span, small { color: var(--text-muted); } span { font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; } strong { color: var(--accent); font-size: clamp(1.8rem, 5vw, 3rem); line-height: 1; } small { margin-top: .3rem; } }
.pot-focus__facts { display: grid; grid-template-columns: repeat(2, minmax(90px,1fr)); gap: .4rem; span { display: grid; align-content: center; padding: .65rem; border-radius: 14px; background: rgba(255,255,255,.045); } small { color: var(--text-muted); } strong { margin-top: .15rem; } }
.pot-focus__turn { position: relative; z-index: 1; display: grid; grid-template-columns: auto 1fr; align-content: center; gap: .05rem .5rem; padding: .7rem; border: 1px solid rgba(90,196,130,.18); border-radius: 15px; background: rgba(90,196,130,.07); i { grid-row: 1 / 3; align-self: center; width: 9px; height: 9px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 5px rgba(90,196,130,.1); } span { color: var(--text-muted); font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; } strong { overflow-wrap: anywhere; } }
@media (max-width: 700px) { .pot-focus { grid-template-columns: 1fr 1fr; } .pot-focus__turn { grid-column: 1 / -1; } .pot-focus__facts { grid-template-columns: 1fr; } }
</style>
