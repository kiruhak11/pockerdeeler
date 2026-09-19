<script setup lang="ts">
import AppIcon from '~/components/ui/AppIcon.vue'
import { useAccountStore } from '~/stores/account'
import type { CrashState } from '~/types/crash'

const account = useAccountStore()
const auth = useAccountAuth()
const stake = ref(100)
const autoCashoutEnabled = ref(false)
const autoCashout = ref(2)
const data = ref<CrashState>()
const errorMessage = ref('')
const graph = ref<number[]>([])
const visualMultiplier = ref(1)
let lastRoundId = ''
let animationFrame = 0
const busy = ref(false)
let timer: ReturnType<typeof setInterval>
const ownBetStatus = computed(() => {
  if (!data.value?.bet) return ''
  if (data.value.bet.cashedAt) return `забрано на ${data.value.bet.cashedAt.toFixed(2)}x`
  if (data.value.round.phase === 'crashed') return `проиграно на ${data.value.round.crashAt?.toFixed(2)}x`
  return 'в игре'
})

function getErrorMessage(error: unknown) {
  const candidate = error as { data?: { statusMessage?: string }; message?: string }
  return candidate.data?.statusMessage || candidate.message || 'Не удалось выполнить действие'
}

async function load() {
  try {
    data.value = await $fetch<CrashState>('/api/crash/state')
    if (account.user) account.setUser({ ...account.user, balance: data.value.balance })
    if (data.value.round.id !== lastRoundId) { graph.value = []; lastRoundId = data.value.round.id }
    if (data.value.round.phase === 'crashed' && data.value.round.crashAt !== null) visualMultiplier.value = data.value.round.crashAt
    if (data.value.round.phase === 'flying') graph.value = [...graph.value.slice(-59), data.value.round.multiplier]
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  }
}

async function bet() {
  busy.value = true
  try {
    data.value = await $fetch<CrashState>('/api/crash/bet', { method: 'POST', body: { stake: Number(stake.value), autoCashout: autoCashoutEnabled.value ? Number(autoCashout.value) : null } })
    await auth.loadMe()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  } finally {
    busy.value = false
  }
}

async function cashout() {
  busy.value = true
  try {
    data.value = await $fetch<CrashState>('/api/crash/cashout', { method: 'POST' })
    await auth.loadMe()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = getErrorMessage(error)
  } finally {
    busy.value = false
  }
}

function animateMultiplier() {
  const target = data.value?.round.multiplier ?? 1
  if (data.value?.round.phase === 'flying' && visualMultiplier.value < target) {
    const gap = target - visualMultiplier.value
    visualMultiplier.value = Math.min(target, visualMultiplier.value + Math.min(0.01, Math.max(0.0015, gap * 0.12)))
  } else if (data.value?.round.phase === 'betting') {
    visualMultiplier.value = 1
  }
  animationFrame = requestAnimationFrame(animateMultiplier)
}

onMounted(() => { load(); timer = setInterval(load, 500); animationFrame = requestAnimationFrame(animateMultiplier) })
onBeforeUnmount(() => { clearInterval(timer); cancelAnimationFrame(animationFrame) })
</script>
<template>
  <main class="crash"><header class="hero"><div><small>ЕДИНЫЙ СЕРВЕРНЫЙ РАУНД</small><h1>Ракета</h1><p>Виртуальные фишки <i/> преимущество системы 7% <i/> раунд общий для всех</p></div><div class="bank"><span>БАНК ROCKET · СЕГОДНЯ</span><strong>{{ data?.economy?.rocketBank?.toLocaleString('ru-RU') || 0 }}</strong><small>фишек доступно к выплате</small></div></header>
    <section class="sky" :class="`phase-${data?.round?.phase || 'loading'}`"><div class="sky-grid"/><div class="sky-status"><span>{{ data?.round?.phase === 'betting' ? 'ПРИЁМ СТАВОК' : data?.round?.phase === 'flying' ? 'ПОЛЁТ' : data?.round?.phase === 'crashed' ? 'КРАШ' : 'СИНХРОНИЗАЦИЯ' }}</span><i/></div><div v-if="data?.round?.phase === 'betting'" class="countdown"><small>СТАРТ ЧЕРЕЗ</small><strong>{{ Math.ceil((data.round.startsInMs || 0) / 1000) }}</strong><span>секунд</span></div><svg class="chart" viewBox="0 0 600 220" preserveAspectRatio="none" aria-hidden="true"><polyline v-if="graph.length > 1" :points="graph.map((value, index) => `${index * (600 / Math.max(1, graph.length - 1))},${205 - Math.min(180, Math.log(value) * 70)}`).join(' ')" /></svg><div class="mult"><small>ТЕКУЩИЙ КОЭФФИЦИЕНТ</small>{{ visualMultiplier.toFixed(2) }}<span>x</span></div><div v-if="data?.round?.phase !== 'crashed'" class="rocket"><AppIcon name="rocket" :size="64"/></div><div v-else class="rocket exploded"><AppIcon name="burst" :size="64"/></div><div v-if="data?.round?.phase === 'crashed'" class="crashed"><span>РАУНД ОСТАНОВЛЕН</span><strong>{{ data.round.crashAt?.toFixed(2) }}x</strong></div></section>
    <section class="panel"><div class="panel-title"><div><small>ПАНЕЛЬ ПОЛЁТА</small><h2>{{ data?.bet ? 'Ставка принята' : 'Настройте ставку' }}</h2></div><span class="balance">Баланс <b>{{ Number(account.user?.balance || data?.balance || 0).toLocaleString('ru-RU') }}</b></span></div><div class="bet-grid"><label class="stake-field"><span>Сумма ставки</span><div class="input-shell"><input v-model.number="stake" type="number" min="1" max="1000000" /><b>фишек</b></div></label><div class="quick"><span>БЫСТРЫЙ ВЫБОР</span><button type="button" @click="stake=Number(account.user?.balance || 0)">ALL-IN</button><button v-for="amount in [1000,5000,10000]" :key="amount" type="button" @click="stake=amount">{{ amount.toLocaleString('ru-RU') }}</button></div></div><div class="auto-card" :class="{ active:autoCashoutEnabled }"><label class="toggle"><span class="switch"><input v-model="autoCashoutEnabled" type="checkbox" /><i/></span><span><b>Автовывод</b><small>Автоматически забрать выигрыш на выбранном коэффициенте</small></span></label><div v-if="autoCashoutEnabled" class="auto-controls"><label><span>Коэффициент</span><div class="input-shell compact"><input v-model.number="autoCashout" type="number" min="1.01" max="1000" step="0.01" /><b>×</b></div></label><div class="presets" aria-label="Быстрый выбор коэффициента"><button v-for="value in [1.01, 1.25, 1.5, 2, 3, 5, 10]" :key="value" class="preset" type="button" :class="{ selected:autoCashout===value }" @click="autoCashout = value">{{ value }}×</button></div></div></div><button v-if="!data?.bet" class="primary-action" :disabled="busy || data?.round.phase !== 'betting'" @click="bet"><span>{{ busy ? 'Принимаем ставку…' : data?.round.phase === 'betting' ? 'Поставить' : 'Дождитесь нового раунда' }}</span><b>→</b></button><button v-else-if="!data.bet.cashedAt" class="primary-action cashout-action" :disabled="busy || data.round.phase !== 'flying'" @click="cashout"><span>{{ busy ? 'Забираем…' : 'Забрать выигрыш' }}</span><b>→</b></button><p v-if="data?.bet" class="bet-status"><span>ВАША СТАВКА</span><strong>{{ data.bet.stake.toLocaleString('ru-RU') }} фишек</strong><em>{{ ownBetStatus }}</em><small v-if="data.bet.autoCashout">Авто · {{ data.bet.autoCashout.toFixed(2) }}x</small></p><p v-if="errorMessage" class="error">{{ errorMessage }}</p></section>
    <section class="history"><h2>Последние 10</h2><span v-for="item in data?.history" :key="item.id" :class="`x-${item.crashAt <= 1.2 ? 'red' : item.crashAt <= 1.5 ? 'yellow' : item.crashAt <= 2.5 ? 'green' : item.crashAt <= 10 ? 'purple' : 'gold'}`">{{ item.crashAt.toFixed(2) }}x</span></section>
    <section class="live"><h2>Ставки в раунде <small>{{ data?.stats.players || 0 }} игроков · {{ data?.stats.totalStake || 0 }} фишек</small></h2><div v-for="item in data?.currentBets" :key="item.id" class="live-bet"><strong>{{ item.username }}</strong><span>{{ item.stake }} фишек</span><em v-if="item.cashedAt">забрано на {{ item.cashedAt.toFixed(2) }}x</em><em v-else-if="data?.round.phase === 'crashed'" class="lost">проиграно на {{ data.round.crashAt?.toFixed(2) }}x</em><em v-else>в игре<span v-if="item.autoCashout"> · авто {{ item.autoCashout.toFixed(2) }}x</span></em></div></section>
  </main>
</template>
<style scoped lang="scss">
.crash{--rocket-gold:#edc782;--rocket-mint:#a7e5c3;max-width:860px;margin:auto;padding:8px 0 100px;color:var(--text-primary)}.hero{display:flex;justify-content:space-between;gap:1.5rem;align-items:flex-end}.hero>div:first-child{min-width:0}.hero small,.panel-title small{color:#93b9a7;letter-spacing:.14em;font-size:.65rem}.hero h1{font-size:clamp(2.8rem,8vw,5.4rem);letter-spacing:-.055em;line-height:1;margin:.35rem 0 .75rem}.hero p{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem;color:var(--text-muted);font-size:.82rem;margin:0}.hero p i{width:3px;height:3px;border-radius:50%;background:#668979}.bank{min-width:210px;padding:16px 18px;border:1px solid #e8c78226;border-radius:18px;background:linear-gradient(145deg,#263428,#172820);box-shadow:0 12px 34px #0003}.bank span,.bank small{display:block;font-size:.58rem;letter-spacing:.1em;color:#93aa9d}.bank strong{display:block;margin:7px 0 3px;color:var(--rocket-gold);font-size:1.7rem;letter-spacing:-.03em}
.sky{position:relative;isolation:isolate;display:grid;place-items:center;min-height:420px;margin:1.4rem 0;border:1px solid #a8ddc028;border-radius:30px;background:radial-gradient(circle at 66% 30%,#2c665345,transparent 28%),radial-gradient(circle at 50% 20%,#1c463b,#061a15 66%);box-shadow:0 28px 70px #0005,inset 0 1px #fff1;overflow:hidden}.sky:before,.sky:after{content:"";position:absolute;z-index:-1;border-radius:50%;filter:blur(2px)}.sky:before{width:290px;height:290px;right:-100px;top:-110px;background:#85e5b414;box-shadow:-420px 260px 0 #f0c87e0b}.sky:after{inset:0;border-radius:0;background-image:radial-gradient(circle,#d9f7e6 1px,transparent 1.5px);background-size:43px 43px;opacity:.13;mask-image:linear-gradient(#000,transparent 80%)}.sky-grid{position:absolute;inset:42% 0 0;background-image:linear-gradient(#a7dec10f 1px,transparent 1px),linear-gradient(90deg,#a7dec10f 1px,transparent 1px);background-size:42px 42px;transform:perspective(260px) rotateX(62deg) scale(1.6);transform-origin:bottom}.sky-status{position:absolute;top:18px;left:20px;display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid #ffffff12;border-radius:99px;background:#061a1580;backdrop-filter:blur(12px);font-size:.6rem;letter-spacing:.12em;color:#acc7b9}.sky-status i{width:6px;height:6px;border-radius:50%;background:#a4e7c0;box-shadow:0 0 9px #a4e7c0}.phase-crashed .sky-status i{background:#ff8b75;box-shadow:0 0 9px #ff8b75}.chart{position:absolute;inset:18% 4% 9%;width:92%;height:73%;opacity:.86}.chart polyline{fill:none;stroke:var(--rocket-mint);stroke-width:4;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 9px #92efc688);transition:all .45s ease}.mult{position:relative;z-index:1;display:flex;align-items:flex-end;font-size:clamp(4rem,13vw,7.5rem);line-height:.9;font-weight:850;letter-spacing:-.06em;color:var(--rocket-mint);text-shadow:0 0 34px #9ce6c342;transition:transform .35s ease}.mult small{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);white-space:nowrap;color:#79998a;font-size:.55rem;letter-spacing:.15em}.mult span{padding:0 0 .06em .08em;font-size:.38em;color:#80b69e}.rocket{position:relative;z-index:1;margin-top:30px;font-size:5.2rem;filter:drop-shadow(-12px 20px 12px #0007);animation:fly 2.4s cubic-bezier(.2,.8,.2,1) infinite alternate}.rocket.exploded{animation:explode .55s ease-out both;filter:drop-shadow(0 0 28px #ff8b75)}.countdown{position:absolute;z-index:2;top:18px;right:20px;display:flex;align-items:baseline;gap:6px;color:#c8e2d0}.countdown small{color:#7f9f90;font-size:.55rem;letter-spacing:.12em}.countdown strong{font-size:1.5rem;color:var(--rocket-gold)}.countdown span{font-size:.7rem;color:#8ca899}.crashed{position:absolute;bottom:18px;display:flex;align-items:center;gap:12px;padding:9px 13px;border:1px solid #ff8b7530;border-radius:99px;background:#3b1818aa;color:#ffb09f;backdrop-filter:blur(10px)}.crashed span{font-size:.62rem;letter-spacing:.12em}.crashed strong{font-size:1.1rem}
@keyframes fly{to{transform:translate(35px,-66px) rotate(18deg)}}@keyframes explode{0%{transform:scale(1);opacity:1}100%{transform:scale(1.35) rotate(12deg);opacity:.95}}
.panel{display:grid;gap:18px;padding:22px;border:1px solid #a8dbc124;border-radius:24px;background:linear-gradient(145deg,#112e25,#0c241d);box-shadow:0 22px 55px #0003,inset 0 1px #fff1}.panel-title{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}.panel-title h2{margin:5px 0 0;font-size:1.3rem}.balance{font-size:.7rem;color:#86a395}.balance b{display:block;margin-top:4px;color:#e9d194;font-size:1.15rem;text-align:right}.bet-grid{display:grid;grid-template-columns:minmax(210px,.75fr) 1.25fr;gap:14px;align-items:end}.stake-field,.auto-controls label{display:grid;gap:7px;color:#9bb3a6;font-size:.72rem}.input-shell{display:flex;align-items:center;min-height:48px;border:1px solid #ffffff20;border-radius:13px;background:#061a15;overflow:hidden;transition:border-color .2s,box-shadow .2s}.input-shell:focus-within{border-color:#a6e6c270;box-shadow:0 0 0 3px #a6e6c210}.input-shell input{min-width:0;width:100%;padding:12px 13px;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-weight:750}.input-shell b{padding-right:13px;color:#708f80;font-size:.65rem;white-space:nowrap}.quick{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.quick>span{width:100%;color:#769485;font-size:.58rem;letter-spacing:.11em}.quick button,.preset{min-height:38px;padding:8px 12px;border:1px solid #ffffff17;border-radius:10px;background:#ffffff09;color:#dce9e1;font-weight:750;cursor:pointer;transition:.2s}.quick button:hover,.preset:hover,.preset.selected{border-color:#e4c58370;background:#e4c58316;color:#f2d89f}.quick button:first-of-type{border-color:#e4c58342;color:#f2d89f}.auto-card{padding:15px 16px;border:1px solid #ffffff12;border-radius:17px;background:#071d1780;transition:border-color .25s,background .25s}.auto-card.active{border-color:#a8dfc431;background:linear-gradient(100deg,#14382d,#0a211a)}.toggle{display:flex;align-items:center;gap:12px;cursor:pointer}.toggle>span:last-child{display:grid;gap:3px}.toggle b{font-size:.9rem}.toggle small{color:#7f9b8d;font-size:.68rem;line-height:1.4}.switch{position:relative;flex:0 0 42px;width:42px;height:24px}.switch input{position:absolute;z-index:2;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.switch i{position:absolute;inset:0;border-radius:99px;background:#ffffff18;box-shadow:inset 0 0 0 1px #ffffff15;transition:.2s;pointer-events:none}.switch i:after{content:"";position:absolute;top:4px;left:4px;width:16px;height:16px;border-radius:50%;background:#8aa398;transition:.2s}.switch input:checked+i{background:#a9e6c2}.switch input:focus-visible+i{outline:2px solid var(--rocket-gold);outline-offset:3px}.switch input:checked+i:after{transform:translateX(18px);background:#123528}.auto-controls{display:grid;grid-template-columns:150px 1fr;gap:13px;align-items:end;margin-top:15px;padding-top:14px;border-top:1px solid #ffffff10}.input-shell.compact{min-height:42px}.presets{display:flex;gap:6px;flex-wrap:wrap}.preset{min-height:34px;padding:7px 10px;font-size:.72rem}.primary-action{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:54px;padding:0 17px;border:0;border-radius:15px;background:linear-gradient(110deg,#f2d393,#cfa65e);box-shadow:0 11px 30px #d9b46d1f;color:#17251d;font-weight:850;cursor:pointer}.primary-action b{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#17251d16;font-size:1.15rem}.primary-action:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}.cashout-action{background:linear-gradient(110deg,#b5f0ce,#65bd91)}.bet-status{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:9px;margin:0;padding:12px 14px;border:1px solid #ffffff10;border-radius:13px;background:#ffffff08;color:#98b1a4;font-size:.75rem}.bet-status>span{color:#6f8d7e;font-size:.56rem;letter-spacing:.1em}.bet-status strong{color:#e9f2ec}.bet-status em{color:#a5d4ac;font-style:normal}.bet-status small{color:#d7bf86}.error{margin:0;padding:10px 12px;border-radius:11px;background:#ff8b7512;color:#ffad9d;font-size:.78rem;line-height:1.5}
.history,.live{margin-top:18px}.history{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.history h2,.live h2{width:100%;margin:0 0 7px;font-size:1rem}.history>span{padding:8px 10px;border:1px solid currentColor;border-radius:10px;font-weight:800;font-size:.78rem}.x-red{color:#ff8b75;background:#ff8b7510}.x-yellow{color:#ffd166;background:#ffd16610}.x-green{color:#a5d4ac;background:#a5d4ac10}.x-purple{color:#c5a3ff;background:#c5a3ff10}.x-gold{color:#ffd700;background:#ffd70010}.live h2 small{margin-left:.5rem;letter-spacing:0;color:var(--text-muted);font-weight:400}.live-bet{display:grid;grid-template-columns:1fr auto minmax(150px,auto);gap:12px;align-items:center;padding:11px 13px;margin:6px 0;border:1px solid #ffffff0b;border-radius:13px;background:#ffffff08}.live-bet span{color:#8fa99c;font-size:.8rem}.live-bet em{color:#a5d4ac;font-style:normal;font-size:.8rem;text-align:right}.live-bet em.lost{color:#ff8b75}
@media(max-width:600px){.crash{padding-top:0}.hero{align-items:stretch;flex-direction:column}.hero h1{font-size:3.3rem}.hero p{font-size:.72rem;line-height:1.5}.bank{display:grid;grid-template-columns:1fr auto;align-items:center;min-width:0;padding:12px 14px}.bank span{grid-column:1}.bank strong{grid-column:2;grid-row:1/3;margin:0;font-size:1.35rem}.bank small{grid-column:1}.sky{min-height:350px;margin:14px 0;border-radius:23px}.sky-status{top:13px;left:13px}.countdown{top:14px;right:13px}.countdown small{display:none}.mult{font-size:4.5rem}.mult small{display:none}.rocket{font-size:4.1rem}.panel{gap:14px;padding:16px;border-radius:20px}.panel-title{align-items:flex-start}.balance{white-space:nowrap}.bet-grid{grid-template-columns:1fr}.quick button{flex:1;min-width:64px;padding-inline:8px}.auto-card{padding:13px}.auto-controls{grid-template-columns:1fr}.presets{display:grid;grid-template-columns:repeat(4,1fr)}.preset{padding-inline:4px}.bet-status{grid-template-columns:1fr auto}.bet-status>span{grid-column:1/-1}.bet-status em{text-align:left}.live h2{display:grid;gap:4px}.live h2 small{margin-left:0}.live-bet{grid-template-columns:1fr auto}.live-bet em{grid-column:1/-1;text-align:left}.history{gap:6px}.history>span{padding:7px 8px;font-size:.72rem}}
@media(max-width:360px){.sky{min-height:325px}.sky-status span{font-size:0}.sky-status span:after{content:"LIVE";font-size:.6rem}.mult{font-size:4rem}.panel-title{display:grid}.balance b{text-align:left}.presets{grid-template-columns:repeat(3,1fr)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
