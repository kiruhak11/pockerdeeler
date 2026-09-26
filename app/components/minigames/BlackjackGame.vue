<script setup lang="ts">
import { useAccountStore } from '~/stores/account'

type Card = { rank: string; suit: string; code: string } | { hidden: true }
type Round = {
  roundId: string; status: 'ACTIVE' | 'FINISHED'; stake: number; playerCards: Card[]; dealerCards: Card[];
  playerTotal: number; dealerTotal: number; dealerSoft: boolean; dealerHoleHidden: boolean;
  outcome: 'WIN' | 'LOSE' | 'PUSH' | 'BLACKJACK' | null; payout: number; netChange: number; balance: number
}
const account = useAccountStore()
const round = ref<Round | null>(null)
const balance = ref(0)
const stake = ref(100)
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const numberFormat = new Intl.NumberFormat('ru-RU')
const maxEvenStake = computed(() => Math.max(0, balance.value - balance.value % 2))
const outcomeText = computed(() => {
  const labels: Record<string, string> = { WIN: 'Победа', LOSE: 'Раунд за дилером', PUSH: 'Ничья — ставка возвращена', BLACKJACK: 'Натуральный блэкджек!' }
  return labels[round.value?.outcome ?? ''] ?? ''
})
const outcomeIcon = computed(() => {
  const icons: Record<string, string> = { WIN: '✦', LOSE: '×', PUSH: '＝', BLACKJACK: '♠' }
  return icons[round.value?.outcome ?? ''] ?? ''
})

function message(error: unknown) {
  const value = error as { data?: { statusMessage?: string } }
  return value.data?.statusMessage || 'Не удалось связаться со столом. Проверьте соединение и обновите состояние.'
}

async function loadState() {
  const result = await $fetch<{ round: Round | null; balance: number }>('/api/blackjack/state')
  round.value = result.round
  balance.value = result.balance
  if (account.user) account.setUser({ ...account.user, balance: result.balance })
  if (!round.value) stake.value = Math.min(Math.max(2, stake.value), Math.max(2, maxEvenStake.value))
}

async function refresh() {
  loading.value = true
  errorMessage.value = ''
  try { await loadState() }
  catch (error) { errorMessage.value = message(error) }
  finally { loading.value = false }
}

async function start() {
  if (busy.value || stake.value < 2 || stake.value % 2 || stake.value > balance.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await $fetch<{ round: Round }>('/api/blackjack/start', { method: 'POST', retry: 0, body: { stake: stake.value, requestId: crypto.randomUUID() } })
    round.value = result.round
    balance.value = result.round.balance
    if (account.user) account.setUser({ ...account.user, balance: balance.value })
  } catch (error) { errorMessage.value = message(error); await loadState().catch(() => {}) }
  finally { busy.value = false }
}

async function action(kind: 'hit' | 'stand') {
  if (!round.value || round.value.status !== 'ACTIVE' || busy.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const result = await $fetch<{ round: Round }>(`/api/blackjack/${kind}`, { method: 'POST', retry: 0, body: { roundId: round.value.roundId, requestId: crypto.randomUUID() } })
    round.value = result.round
    balance.value = result.round.balance
    if (account.user) account.setUser({ ...account.user, balance: balance.value })
  } catch (error) { errorMessage.value = message(error); await loadState().catch(() => {}) }
  finally { busy.value = false }
}

function selectMax() {
  if (maxEvenStake.value >= 2) stake.value = maxEvenStake.value
}
function suitMark(suit: string) { return ({ S: '♠', H: '♥', D: '♦', C: '♣' } as Record<string, string>)[suit] ?? suit }
function cardLabel(card: Card) { return 'hidden' in card ? 'Закрытая карта дилера' : `${card.rank} ${suitMark(card.suit)}` }
function cardRed(card: Card) { return !('hidden' in card) && (card.suit === 'H' || card.suit === 'D') }
onMounted(() => void refresh())
</script>

<template>
  <section class="bj-shell" aria-label="Блэкджек">
    <header class="bj-heading">
      <div><p class="arcade-eyebrow">POKER DEALER DESK / BLACKJACK</p><h1>Двадцать одно</h1><p class="bj-subtitle">Ты против дилера. Решение за тобой.</p></div>
      <div class="bj-balance"><span>ТВОЙ БАЛАНС</span><strong>{{ numberFormat.format(balance) }} <i>фишек</i></strong></div>
    </header>

    <section class="bj-table" :class="{ 'bj-table-live': round?.status === 'ACTIVE' }">
      <div class="bj-table-lights" aria-hidden="true"/>
      <div class="bj-rule-chip">ДИЛЕР СТОИТ НА SOFT 17 <span>•</span> BLACKJACK 3:2</div>

      <div v-if="loading" class="bj-loading" aria-live="polite"><span class="bj-spinner"/>Собираем стол…</div>
      <template v-else>
        <div class="bj-hand bj-dealer">
          <div class="bj-hand-meta"><div><span class="bj-player-label">ДИЛЕР</span><span v-if="round?.dealerHoleHidden" class="bj-quiet">Одна карта закрыта</span><span v-else class="bj-quiet">Рука дилера</span></div><strong v-if="round">{{ round.dealerHoleHidden ? round.dealerTotal + '+' : round.dealerTotal }}<small v-if="round.dealerSoft && !round.dealerHoleHidden"> soft</small></strong></div>
          <div class="bj-cards"><div v-for="(card,index) in round?.dealerCards ?? []" :key="'d'+index" class="bj-card" :class="{ 'bj-card-back':'hidden' in card, 'bj-card-red':cardRed(card), 'bj-card-reveal':round && !round.dealerHoleHidden && index===1 }" :style="{ animationDelay: `${index * 70}ms` }" :aria-label="cardLabel(card)"><template v-if="'hidden' in card"><span class="bj-card-back-mark">♠</span><span class="bj-card-back-brand">P D</span></template><template v-else><span class="bj-card-corner">{{ card.rank }}<i>{{ suitMark(card.suit) }}</i></span><b>{{ suitMark(card.suit) }}</b><span class="bj-card-corner bj-card-corner-bottom">{{ card.rank }}<i>{{ suitMark(card.suit) }}</i></span></template></div><span v-if="!round" class="bj-empty-cards">Твои карты уже тасуются в колоде</span></div>
        </div>

        <div class="bj-center-line"><span>♣</span><i/><span>♠</span></div>

        <div class="bj-hand bj-player">
          <div class="bj-hand-meta"><div><span class="bj-player-label">ТВОЯ РУКА</span><span class="bj-quiet">Ставка · {{ numberFormat.format(round?.stake ?? stake) }}</span></div><strong v-if="round">{{ round.playerTotal }}</strong></div>
          <div class="bj-cards"><div v-for="(card,index) in round?.playerCards ?? []" :key="'p'+index" class="bj-card" :class="{ 'bj-card-red':cardRed(card) }" :style="{ animationDelay: `${index * 70}ms` }" :aria-label="cardLabel(card)"><span class="bj-card-corner">{{ 'hidden' in card ? '?' : card.rank }}<i v-if="!('hidden' in card)">{{ suitMark(card.suit) }}</i></span><b v-if="!('hidden' in card)">{{ suitMark(card.suit) }}</b><span v-if="!('hidden' in card)" class="bj-card-corner bj-card-corner-bottom">{{ card.rank }}<i>{{ suitMark(card.suit) }}</i></span></div><span v-if="!round" class="bj-empty-cards">Твои карты появятся здесь</span></div>
        </div>

        <div v-if="round?.status === 'FINISHED'" class="bj-result" :class="`result-${round.outcome?.toLowerCase()}`" aria-live="polite"><span class="bj-result-icon">{{ outcomeIcon }}</span><div><strong>{{ outcomeText }}</strong><span>{{ round.netChange > 0 ? `+${numberFormat.format(round.netChange)} фишек` : round.netChange < 0 ? `−${numberFormat.format(-round.netChange)} фишек` : 'Ставка возвращена' }}</span></div></div>
      </template>
    </section>

    <section class="bj-controls">
      <template v-if="!loading && round?.status === 'ACTIVE'">
        <div class="bj-controls-copy"><div><p class="arcade-eyebrow">ТВОЙ ХОД</p><h2>Как сыграем?</h2></div><span class="bj-turn-pip"><i/>Твой выбор</span></div>
        <div class="bj-actions"><button class="bj-hit" :disabled="busy" @click="action('hit')"><span>＋</span><b>Взять карту</b><small>Ещё одна карта</small></button><button class="bj-stand" :disabled="busy" @click="action('stand')"><span>✓</span><b>Хватит</b><small>Передать ход дилеру</small></button></div>
      </template>
      <template v-else-if="!loading && (!round || round.status === 'FINISHED')">
        <div class="bj-controls-copy"><div><p class="arcade-eyebrow">{{ round ? 'НОВАЯ РАЗДАЧА' : 'СДЕЛАЙ СТАВКУ' }}</p><h2>{{ round ? 'Ещё одну?' : 'Сыграем?' }}</h2></div><span class="bj-payout-tag">NATURAL <b>3:2</b></span></div>
        <label class="bj-bet-label" for="blackjack-stake">Ставка <span>Чётная сумма · 1:1 за победу · natural 3:2</span></label>
        <div class="bj-bet-row"><div class="bj-bet-input"><input id="blackjack-stake" v-model.number="stake" type="number" min="2" :max="maxEvenStake" step="2" inputmode="numeric" :disabled="busy" @keydown.enter.prevent="start"><span>фишек</span></div><button class="bj-max" :disabled="busy || maxEvenStake < 2" @click="selectMax">МАКС</button><button class="bj-start" :disabled="busy || stake < 2 || stake % 2 !== 0 || stake > balance" @click="start">{{ busy ? 'Раздаём…' : round ? 'Играть снова' : 'Начать игру' }} <span>→</span></button></div>
        <p class="bj-bet-note">Ставка списывается один раз при старте. При ничьей она возвращается.</p>
      </template>
      <p v-if="errorMessage" class="bj-error" role="alert">{{ errorMessage }}</p>
    </section>
    <footer class="bj-footnote"><span>52 карты · одна колода на раунд</span><span>Только виртуальные фишки</span><span>Раздача восстановится после обновления</span></footer>
  </section>
</template>

<style scoped>
.bj-shell{--bj-gold:#efd28f;--bj-mint:#a8e4c0;color:#edf4ef}.bj-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin:6px 0 22px}.bj-heading h1{margin:0;font-size:clamp(28px,4vw,42px);line-height:1.05;letter-spacing:-.045em}.bj-heading .arcade-eyebrow{margin-bottom:9px}.bj-subtitle{margin:9px 0 0;color:#93aa9c;font-size:13px}.bj-balance{padding:13px 16px;border:1px solid #d6bb7540;border-radius:15px;background:#18261e;min-width:180px}.bj-balance>span,.bj-bet-label span{display:block;color:#8da596;font-size:9px;letter-spacing:.14em}.bj-balance strong{display:block;color:var(--bj-gold);font-size:21px;margin-top:5px;font-variant-numeric:tabular-nums}.bj-balance i{color:#9aab9f;font-size:10px;font-style:normal;font-weight:500}.bj-table{position:relative;isolation:isolate;overflow:hidden;min-height:438px;padding:24px clamp(20px,5vw,58px) 29px;border:1px solid #d6b86f52;border-radius:28px;background:radial-gradient(ellipse at 50% 45%,#22634a,#114435 55%,#0c3027);box-shadow:inset 0 0 0 8px #0a2c2360,inset 0 0 80px #041d18,0 28px 60px #0004}.bj-table:before{content:'';position:absolute;z-index:-1;inset:14px;border:1px solid #f3d99c31;border-radius:22px;pointer-events:none}.bj-table-lights{position:absolute;z-index:-1;width:280px;height:220px;left:calc(50% - 140px);top:90px;background:#b0f0be0d;filter:blur(40px);pointer-events:none}.bj-table-live .bj-table-lights{background:#b0f0be19}.bj-rule-chip{position:absolute;top:22px;left:50%;transform:translateX(-50%);white-space:nowrap;color:#c5c395;font-size:8px;letter-spacing:.17em}.bj-rule-chip span{padding:0 7px;color:#eccb84}.bj-hand{position:relative;z-index:1}.bj-dealer{padding-top:35px}.bj-player{padding-bottom:3px}.bj-hand-meta{display:flex;justify-content:space-between;align-items:center;max-width:650px;margin:0 auto 9px}.bj-hand-meta>div{display:flex;align-items:baseline;gap:11px}.bj-player-label{font-size:9px;letter-spacing:.17em;font-weight:800;color:#d8d8b3}.bj-quiet{font-size:10px;color:#a5c2ae}.bj-hand-meta>strong{color:#f7e4ad;font-size:21px;font-variant-numeric:tabular-nums}.bj-hand-meta>strong small{font-size:9px;color:#b8c8b0}.bj-cards{display:flex;align-items:center;justify-content:center;gap:clamp(7px,1.4vw,14px);min-height:112px}.bj-card{position:relative;width:66px;height:96px;flex:0 0 auto;display:grid;place-items:center;border-radius:9px;background:linear-gradient(145deg,#fffefa,#e6e4da);color:#1b2722;box-shadow:0 7px 16px #071c164f,0 1px 1px #fff inset;animation:bj-deal .34s cubic-bezier(.2,.75,.3,1) both}.bj-card-red{color:#bb4a43}.bj-card>b{font-family:Georgia,serif;font-size:29px;font-weight:500}.bj-card-corner{position:absolute;top:6px;left:7px;display:flex;flex-direction:column;align-items:center;font:700 13px/1 Georgia,serif}.bj-card-corner i{font-style:normal;font-size:10px}.bj-card-corner-bottom{top:auto;left:auto;right:7px;bottom:6px;transform:rotate(180deg)}.bj-card-back{overflow:hidden;color:#e5ca89;background:repeating-linear-gradient(45deg,#173e32 0 5px,#1e4f3e 5px 10px);border:3px solid #e8d39b;box-shadow:0 0 0 2px #143b30,0 7px 16px #071c164f}.bj-card-back:before{content:'';position:absolute;inset:6px;border:1px solid #efdca47a;border-radius:4px}.bj-card-back-mark{font:35px Georgia,serif}.bj-card-back-brand{position:absolute;bottom:9px;font-size:7px;letter-spacing:.18em}.bj-empty-cards{color:#b4cebb73;font-size:11px;font-style:italic}.bj-center-line{display:flex;align-items:center;justify-content:center;gap:13px;height:54px;color:#d0bd80;font-size:11px;opacity:.7}.bj-center-line i{height:1px;width:min(150px,24vw);background:linear-gradient(90deg,transparent,#ead18b7a,transparent)}.bj-result{display:flex;align-items:center;justify-content:center;gap:11px;width:max-content;max-width:100%;margin:10px auto 0;padding:9px 17px;border:1px solid #d8c27d42;border-radius:14px;background:#0c2a22c9;animation:bj-result-in .35s ease-out}.bj-result-icon{font-size:18px;color:#f3dc9b}.bj-result>div{display:flex;flex-direction:column;gap:2px}.bj-result strong{font-size:12px}.bj-result>div>span{font-size:10px;color:#a8d2b6}.result-lose .bj-result-icon{color:#ee8d81}.result-lose>div>span{color:#eda095}.result-push .bj-result-icon{color:#d9d5b4}.bj-loading{display:flex;justify-content:center;align-items:center;gap:10px;min-height:340px;color:#c0d4c5;font-size:12px}.bj-spinner{width:17px;height:17px;border:2px solid #fff3;border-top-color:#f1d18a;border-radius:50%;animation:bj-spin .7s linear infinite}.bj-controls{margin-top:18px;padding:22px clamp(18px,4vw,34px);border:1px solid #c1d6c01b;border-radius:22px;background:linear-gradient(110deg,#102820,#10251f)}.bj-controls-copy{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:17px}.bj-controls-copy .arcade-eyebrow{font-size:8px;margin:0 0 6px;color:#92b5a0}.bj-controls-copy h2{font-size:20px;margin:0;letter-spacing:-.03em}.bj-payout-tag,.bj-turn-pip{padding:8px 12px;border:1px solid #e2c77a38;border-radius:30px;color:#b7c3ad;font-size:8px;letter-spacing:.12em;white-space:nowrap}.bj-payout-tag b{padding-left:5px;color:#efd18a;font-size:13px}.bj-turn-pip{display:flex;align-items:center;gap:7px;border-color:#9ddbb02e;letter-spacing:.04em;color:#b5d8bf}.bj-turn-pip i{width:6px;height:6px;background:#a5ebbc;border-radius:50%;box-shadow:0 0 8px #a5ebbc}.bj-bet-label{display:block;margin-bottom:7px;color:#d7e1d9;font-size:12px;font-weight:650}.bj-bet-label span{display:inline;margin-left:8px;font-size:8px;font-weight:400;letter-spacing:0}.bj-bet-row{display:grid;grid-template-columns:minmax(130px,1fr) auto minmax(170px,1.2fr);gap:9px}.bj-bet-input{display:flex;align-items:center;gap:10px;padding:0 13px;border:1px solid #b7d0bd25;border-radius:12px;background:#081b16}.bj-bet-input input{width:100%;min-width:0;padding:12px 0;border:0;outline:0;background:transparent;color:#f1ead8;font:700 15px inherit;font-variant-numeric:tabular-nums}.bj-bet-input input::-webkit-inner-spin-button,.bj-bet-input input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.bj-bet-input input[type=number]{appearance:textfield}.bj-bet-input span{color:#7e9c89;font-size:9px;white-space:nowrap}.bj-max,.bj-start{border-radius:12px;padding:0 17px;font:700 11px inherit;cursor:pointer}.bj-max{border:1px solid #d9bd7742;background:#dcc17a10;color:#e8cf94}.bj-start{display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid #f1d893;background:linear-gradient(110deg,#f3d997,#d6ae68);color:#202a21;font-size:12px;box-shadow:0 5px 20px #d9b76d1b}.bj-start span{font-size:17px}.bj-max:disabled,.bj-start:disabled,.bj-actions button:disabled{opacity:.45;cursor:not-allowed}.bj-bet-note{margin:9px 0 0;color:#789081;font-size:9px}.bj-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bj-actions button{position:relative;display:grid;grid-template-columns:42px 1fr;grid-template-rows:auto auto;align-items:center;min-height:66px;text-align:left;padding:10px 16px;border-radius:14px;cursor:pointer}.bj-actions button>span{grid-row:1/3;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;font-size:18px}.bj-actions b{font-size:13px}.bj-actions small{font-size:9px;color:#879f90}.bj-hit{border:1px solid #a6d3b43a;background:#16382b;color:#dcf0df}.bj-hit>span{background:#8bdda21c;color:#a5e2b8}.bj-stand{border:1px solid #d8c17b45;background:#2c2c20;color:#f0e0b4}.bj-stand>span{background:#e7cd7b18;color:#edd28b}.bj-error{margin:13px 0 0;color:#ff9b89;font-size:12px}.bj-footnote{display:flex;justify-content:center;flex-wrap:wrap;gap:9px 21px;padding:16px 5px;color:#718d7e;font-size:8px}.bj-footnote span+span:before{content:'•';margin-right:21px;color:#d2bd7c}.bj-shell button:focus-visible,.bj-bet-input:focus-within{outline:2px solid #eed08d;outline-offset:3px}.bj-shell button{transition:transform .15s,filter .15s}.bj-shell button:not(:disabled):active{transform:translateY(1px);filter:brightness(.95)}
@keyframes bj-spin{to{transform:rotate(360deg)}}@keyframes bj-deal{from{opacity:0;transform:translateY(-12px) rotate(-5deg)}to{opacity:1;transform:translateY(0) rotate(0)}}@keyframes bj-result-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.bj-heading{align-items:flex-start}.bj-heading h1{font-size:30px}.bj-subtitle{font-size:11px}.bj-balance{min-width:132px;padding:10px 11px}.bj-balance strong{font-size:16px}.bj-balance>span{font-size:7px}.bj-table{min-height:408px;padding:22px 14px 24px;border-radius:21px;box-shadow:inset 0 0 0 5px #0a2c2360,inset 0 0 60px #041d18,0 16px 35px #0004}.bj-table:before{inset:9px;border-radius:16px}.bj-rule-chip{top:17px;font-size:6px;letter-spacing:.1em}.bj-dealer{padding-top:33px}.bj-hand-meta{padding:0 8px}.bj-player-label{font-size:8px}.bj-quiet{font-size:8px}.bj-hand-meta>strong{font-size:18px}.bj-card{width:54px;height:78px;border-radius:7px}.bj-card>b{font-size:23px}.bj-card-corner{top:5px;left:5px;font-size:11px}.bj-card-corner i{font-size:8px}.bj-card-corner-bottom{left:auto;right:5px;bottom:5px}.bj-card-back-mark{font-size:29px}.bj-card-back-brand{bottom:7px;font-size:6px}.bj-cards{gap:6px;min-height:93px}.bj-center-line{height:40px}.bj-result{padding:8px 12px}.bj-result strong{font-size:11px}.bj-controls{padding:18px 15px;border-radius:18px}.bj-controls-copy h2{font-size:18px}.bj-bet-row{grid-template-columns:minmax(0,1fr) auto;gap:8px}.bj-bet-input{grid-column:1/2}.bj-max{min-height:44px}.bj-start{grid-column:1/3;min-height:47px}.bj-bet-label span{display:block;margin:4px 0 0}.bj-actions{gap:8px}.bj-actions button{grid-template-columns:33px 1fr;padding:9px 8px;min-height:66px}.bj-actions button>span{width:29px;height:29px;font-size:16px}.bj-actions b{font-size:11px}.bj-actions small{font-size:8px}.bj-footnote{gap:6px 11px;font-size:7px}.bj-footnote span+span:before{margin-right:11px}}
@media(max-width:360px){.bj-heading{gap:8px}.bj-heading h1{font-size:26px}.bj-balance{min-width:118px}.bj-balance strong{font-size:14px}.bj-table{padding-inline:10px}.bj-card{width:48px;height:71px}.bj-cards{gap:4px}.bj-actions button{grid-template-columns:28px 1fr;padding-inline:6px}.bj-actions b{font-size:10px}}
@media(prefers-reduced-motion:reduce){.bj-shell *{animation:none!important;transition:none!important}}
.bj-bet-input input{font-family:inherit;font-size:15px;font-weight:700}.bj-max,.bj-start{font-family:inherit;font-size:11px;font-weight:700}
@keyframes bj-reveal{from{transform:rotateY(90deg);filter:brightness(.7)}to{transform:rotateY(0);filter:brightness(1)}}
.bj-card-reveal{animation:bj-reveal .42s cubic-bezier(.2,.75,.3,1) both;backface-visibility:hidden}
@media(prefers-reduced-motion:reduce){.bj-card-reveal{animation:none}}
</style>
