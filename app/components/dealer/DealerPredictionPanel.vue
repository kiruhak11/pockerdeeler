<script setup lang="ts">
import type { DealerPredictionState } from '~/types/prediction'

const props = defineProps<{ state: DealerPredictionState | null; busy?: boolean }>()
const emit = defineEmits<{
  decideEntry: [memberId: string, decision: 'approve' | 'reject', rebindMemberId?: string]
  decideReentry: [requestId: string, decision: 'approve' | 'reject']
  voidMarket: [marketId: string, reason: string]
}>()

const rebindTargets = reactive<Record<string, string>>({})
const existingTargets = computed(() => (props.state?.members || []).filter(member => member.state !== 'pending'))
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 500) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
const lockCountdown = computed(() => {
  const due = props.state?.currentMarket?.lockDueAt
  return due ? Math.max(0, Math.ceil((new Date(due).getTime() - now.value) / 1000)) : null
})
const marketStatus = computed(() => ({
  scheduled: 'Готовится', open: 'Принимает прогнозы', locked: 'Зафиксирован', settled: 'Рассчитан', void: 'Возвращён'
}[props.state?.currentMarket?.status || 'scheduled']))
const betStatusText: Record<string, string> = {
  open: 'ожидает результата', won: 'выиграл', lost: 'проиграл', refunded: 'возвращён'
}

function requestMarketVoid() {
  const market = props.state?.currentMarket
  if (!market || !['open', 'locked', 'scheduled'].includes(market.status)) return
  const reason = prompt('Укажите причину отмены рынка (она попадёт в аудит):')?.trim()
  if (!reason || reason.length < 3) return
  if (confirm('Отменить рынок и вернуть все поставленные очки зрителям?')) emit('voidMarket', market.id, reason)
}
</script>

<template>
  <section v-if="state && (state.currentMarket || state.entryRequests.length || state.reentryRequests.length)" class="dealer-predictions">
    <header>
      <div>
        <p class="dealer-predictions__eyebrow">Зрительская игра</p>
        <h2>Прогнозы и возвраты</h2>
      </div>
      <div v-if="state.currentMarket" class="dealer-predictions__reserve"><span>Резерв</span><strong>{{ state.treasuryBalance }}</strong></div>
    </header>

    <section v-if="state.entryRequests.length" class="dealer-predictions__requests">
      <h3>Новые люди после старта</h3>
      <article v-for="member in state.entryRequests" :key="member.id" class="request-card">
        <div><strong>{{ member.displayName }}</strong><span>Запрашивает бай-ин {{ member.requestedBuyIn }}</span></div>
        <label>
          <span>Если это прежний участник</span>
          <select v-model="rebindTargets[member.id]" class="input">
            <option value="">Это новый человек</option>
            <option v-for="target in existingTargets" :key="target.id" :value="target.id">Привязать к {{ target.displayName }}</option>
          </select>
        </label>
        <div class="request-card__actions">
          <button class="btn btn--success" type="button" :disabled="busy" @click="emit('decideEntry', member.id, 'approve', rebindTargets[member.id] || undefined)">Разрешить</button>
          <button class="btn btn--danger" type="button" :disabled="busy" @click="emit('decideEntry', member.id, 'reject')">Отклонить</button>
        </div>
      </article>
    </section>

    <section v-if="state.reentryRequests.length" class="dealer-predictions__requests">
      <h3>Возвращение за стол</h3>
      <article v-for="request in state.reentryRequests" :key="request.id" class="request-card request-card--compact">
        <div><strong>{{ request.memberName }}</strong><span>Заработанный стек: {{ request.amount }}</span></div>
        <div class="request-card__actions">
          <button class="btn btn--success" type="button" :disabled="busy" @click="emit('decideReentry', request.id, 'approve')">Вернуть</button>
          <button class="btn btn--danger" type="button" :disabled="busy" @click="emit('decideReentry', request.id, 'reject')">Отклонить</button>
        </div>
      </article>
    </section>

    <section v-if="state.currentMarket" class="dealer-predictions__market">
      <div v-if="state.currentMarket" class="market-summary">
        <div><span>Рынок раздачи №{{ state.currentMarket.handNumber }}</span><strong>{{ state.currentMarket.question }}</strong></div>
        <b :data-status="state.currentMarket.status">{{ marketStatus }}</b>
        <span>Общий фонд: {{ state.currentMarket.totalPool }}</span>
        <span v-if="lockCountdown !== null && state.currentMarket.status === 'open'">
          Старый рынок закроется через {{ lockCountdown }} сек. Не задерживает игру.
        </span>
      </div>
      <p v-else>Активного рынка нет. Он появится в следующей раздаче, если есть выбывший прогнозист.</p>

      <div v-if="state.currentMarket?.quotes.length" class="dealer-predictions__quotes">
        <article v-for="quote in state.currentMarket.quotes" :key="quote.playerId">
          <strong>{{ quote.playerName }}</strong>
          <span>× {{ quote.odds.toFixed(2) }}</span>
          <small>оценка {{ Math.round(quote.modelScore * 100) }}% · реальные ставки {{ quote.realStake }}</small>
        </article>
      </div>

      <div v-if="state.bets.length" class="dealer-predictions__bets">
        <h3>Принятые прогнозы</h3>
        <p v-for="bet in state.bets" :key="bet.id">{{ bet.memberName || 'Участник' }} → {{ bet.candidateName }} · {{ bet.stake }} · {{ betStatusText[bet.status] || bet.status }}<span v-if="bet.acceptedOdds !== null"> · Зафиксировано ×{{ bet.acceptedOdds.toFixed(2) }}, выплата {{ bet.potentialPayout }}</span></p>
      </div>
      <button
        v-if="state.currentMarket && ['open', 'locked', 'scheduled'].includes(state.currentMarket.status)"
        class="btn btn--danger dealer-predictions__void"
        type="button"
        :disabled="busy"
        @click="requestMarketVoid"
      >
        Отменить рынок и вернуть прогнозы
      </button>
    </section>
  </section>
</template>

<style scoped lang="scss">
.dealer-predictions { display: grid; gap: .8rem; padding: 1rem; border: 1px solid rgba(240,188,79,.28); border-radius: var(--radius-lg); background: linear-gradient(145deg, rgba(240,188,79,.08), rgba(0,0,0,.18)); h2,h3,p { margin: 0; } header { display:flex; justify-content:space-between; gap:1rem; } &__eyebrow { color:var(--accent-strong); font-size:.72rem; font-weight:800; letter-spacing:.12em; text-transform:uppercase; } &__reserve { display:grid; text-align:right; span { color:var(--text-muted); font-size:.75rem; } strong { color:var(--accent-strong); font-size:1.5rem; } } &__requests { display:grid; gap:.55rem; } &__market { display:grid; gap:.65rem; padding:.8rem; border-radius:var(--radius-md); background:rgba(0,0,0,.2); >p { color:var(--text-muted); } } &__quotes { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:.45rem; article { display:grid; gap:.2rem; padding:.65rem; border-radius:var(--radius-sm); background:rgba(255,255,255,.05); span { color:var(--accent-strong); font-weight:800; } small { color:var(--text-muted); } } } &__bets { display:grid; gap:.3rem; p { color:var(--text-muted); } } }
.request-card { display:grid; grid-template-columns:minmax(140px,1fr) minmax(220px,1.4fr) auto; gap:.6rem; align-items:end; padding:.7rem; border-radius:var(--radius-md); background:rgba(255,255,255,.05); >div:first-child,label { display:grid; gap:.25rem; span { color:var(--text-muted); font-size:.78rem; } } &--compact { grid-template-columns:1fr auto; } &__actions { display:flex; gap:.4rem; } }
.market-summary { display:flex; gap:.7rem; justify-content:space-between; align-items:center; flex-wrap:wrap; >div { display:grid; span { color:var(--text-muted); font-size:.76rem; } } >b { color:var(--accent-strong); text-transform:uppercase; } >span { color:var(--text-muted); } }
@media(max-width:760px){.request-card,.request-card--compact{grid-template-columns:1fr;align-items:stretch}.request-card__actions{display:grid;grid-template-columns:1fr 1fr}}
</style>
