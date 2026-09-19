<script setup lang="ts">
import type { PredictionViewerState } from '~/types/prediction'
import { streetNames, type Street } from '~/utils/bettingRounds'

const props = defineProps<{ state: PredictionViewerState; busy?: boolean }>()
const emit = defineEmits<{
  bet: [candidatePlayerId: string, stake: number, expectedMarketRevision: number]
  reentry: [amount: number]
}>()

const selectedPlayerId = ref('')
const stake = ref(0)
const reentryAmount = ref(0)
const resultModal = reactive({ visible: false, title: '', amount: 0, tone: 'neutral' as 'win' | 'loss' | 'neutral' })
const notifiedResultId = ref('')
const waitingFor = ref<Street | null>(null)
const streetOrder: Street[] = ['preflop', 'flop', 'turn', 'river']
const waitKey = computed(() => `prediction-wait:${props.state.memberId}:${props.state.currentMarket?.id}`)
const nextStreet = computed(() => streetOrder[streetOrder.indexOf(props.state.currentMarket?.street || 'preflop') + 1])
const waitLabels: Record<Street, string> = { preflop: '', flop: 'Дождаться флопа', turn: 'Дождаться тёрна', river: 'Дождаться ривера' }
function setWaiting(street: Street | null) {
  waitingFor.value = street
  try { if (street) sessionStorage.setItem(waitKey.value, street); else sessionStorage.removeItem(waitKey.value) } catch { /* Storage can be unavailable in private browsers. */ }
}
function restoreWaiting() {
  try {
    const saved = sessionStorage.getItem(waitKey.value) as Street | null
    waitingFor.value = saved && streetOrder.indexOf(saved) > streetOrder.indexOf(props.state.currentMarket?.street || 'preflop') ? saved : null
  } catch { waitingFor.value = null }
}
onMounted(restoreWaiting)
watch(waitKey, restoreWaiting)
watch(() => props.state.currentMarket?.street, street => {
  if (street && waitingFor.value && streetOrder.indexOf(street) >= streetOrder.indexOf(waitingFor.value)) setWaiting(null)
})
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 500)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const lockCountdown = computed(() => {
  const due = props.state.currentMarket?.lockDueAt
  if (!due) return null
  return Math.max(0, Math.ceil((new Date(due).getTime() - now.value) / 1000))
})

watch(() => props.state.currentMarket?.id, () => {
  selectedPlayerId.value = ''
  stake.value = props.state.minStake
}, { immediate: true })

watch(() => {
  const bet = props.state.currentBet
  return bet ? `${bet.id}:${bet.status}` : ''
}, (key) => {
  const bet = props.state.currentBet
  if (!bet || !['won', 'lost', 'refunded'].includes(bet.status) || key === notifiedResultId.value) return
  notifiedResultId.value = key
  resultModal.visible = true
  if (bet.status === 'won') {
    resultModal.title = 'Выигрыш'
    resultModal.amount = bet.netProfit
    resultModal.tone = bet.netProfit > 0 ? 'win' : 'neutral'
  } else if (bet.status === 'lost') {
    resultModal.title = 'Проигрыш'
    resultModal.amount = -bet.stake
    resultModal.tone = 'loss'
  } else {
    resultModal.title = 'Без изменений'
    resultModal.amount = 0
    resultModal.tone = 'neutral'
  }
  window.setTimeout(() => { resultModal.visible = false }, 3000)
}, { immediate: true })

watch(() => props.state.availableProfit, value => {
  reentryAmount.value = Math.min(props.state.comebackMaxBuyIn, Math.max(props.state.comebackMinBuyIn, value))
}, { immediate: true })

const canBet = computed(() => {
  const market = props.state.currentMarket
  return !props.busy && !waitingFor.value && market?.acceptingBets && lockCountdown.value !== 0 && !props.state.currentBet
    && market.quotes.some(quote => quote.playerId === selectedPlayerId.value && quote.available)
    && Number.isSafeInteger(stake.value) && stake.value >= props.state.minStake && stake.value <= props.state.maxStake
})

const canReenter = computed(() => !props.busy
  && !props.state.pendingReentry
  && props.state.reentryCount < props.state.maxReentries
  && reentryAmount.value >= props.state.comebackMinBuyIn
  && reentryAmount.value <= props.state.comebackMaxBuyIn
  && reentryAmount.value <= props.state.availableProfit)

const statusText = computed(() => {
  const status = props.state.currentMarket?.status
  if (!status) return 'Следующий рынок откроется после начала новой раздачи.'
  if (status === 'open' && !props.state.currentMarket?.acceptingBets) return 'Приём прогнозов приостановлен. Ждём продолжения игры.'
  if (status === 'open') return props.state.currentMarket?.pricingMode === 'fixed_odds'
    ? 'Прогноз можно сделать на любой улице до завершения торговли. Коэффициент фиксируется при приёме ставки. Стол вас не ждёт.'
    : 'Эта раздача начата до обновления: действуют прежние правила общего пула. Новые правила включатся со следующей раздачи.'
  if (status === 'locked') return 'Прогнозы зафиксированы. Ждём результат раздачи.'
  if (status === 'settled') return 'Рынок рассчитан.'
  if (status === 'void') return 'Рынок отменён, поставленные очки возвращены.'
  return 'Рынок готовится.'
})

const marketStatusText: Record<string, string> = {
  scheduled: 'Готовится',
  open: 'Открыт',
  locked: 'Зафиксирован',
  settled: 'Рассчитан',
  void: 'Отменён'
}

const betStatusText: Record<string, string> = {
  open: 'ожидает результата',
  won: 'выиграл',
  lost: 'проиграл',
  refunded: 'возвращён'
}

const reasonText: Record<string, string> = {
  all_in_now: 'ва-банк в этой раздаче',
  aggressive_now: 'активная линия',
  careful_line: 'осторожная линия',
  historically_aggressive: 'часто повышает',
  often_reaches_showdown: 'часто доходит до вскрытия',
  limited_history: 'пока мало истории',
  quick_decision: 'быстрое решение',
  long_decision: 'долгое решение',
  not_in_hand: 'не участвует в раздаче'
}

function submitBet() {
  if (!canBet.value) return
  const quote = props.state.currentMarket?.quotes.find(item => item.playerId === selectedPlayerId.value)
  const market = props.state.currentMarket
  if (!quote || !market) return
  const revision = market.revision
  const payout = Math.floor(stake.value * Math.round(quote.odds * 100) / 100)
  const terms = market.pricingMode === 'fixed_odds' ? `Фиксируем ×${quote.odds.toFixed(2)}. Выплата при победе ${payout} (включая ставку).` : `Общий пул: окончательная выплата зависит от остальных прогнозов.`
  if (!confirm(`${quote.playerName} выиграет основной банк. Ставка ${stake.value}. ${terms} При делёжке ставка не проигрывает: чистый выигрыш будет разделён между победителями. Подтвердить?`)) return
  emit('bet', selectedPlayerId.value, Math.trunc(stake.value), revision)
}

function submitReentry() {
  if (!canReenter.value || !confirm(`Запросить возвращение за стол со стеком ${reentryAmount.value}? Стартовые очки останутся недоступны для переноса.`)) return
  emit('reentry', Math.trunc(reentryAmount.value))
}
</script>

<template>
  <section class="prediction-dashboard">
    <header class="prediction-dashboard__hero">
      <div>
        <p class="prediction-dashboard__eyebrow">Второй шанс</p>
        <h2>Прогнозы зрителя</h2>
        <p>Это игровая оценка публичного поведения, а не знание карт.</p>
      </div>
      <div class="prediction-dashboard__balance">
        <span>Очки прогнозов</span>
        <strong>{{ state.balance }}</strong>
      </div>
    </header>

    <div class="prediction-dashboard__economy">
      <div><span>Стартовая часть</span><b>{{ state.grantRemaining }}</b><small>не переносится за стол</small></div>
      <div><span>Чистая прибыль</span><b class="profit">+{{ state.availableProfit }}</b><small>можно использовать для возврата</small></div>
    </div>

    <p v-if="!state.eligible" class="prediction-dashboard__notice">{{ state.reason }}</p>

    <template v-else>
      <section class="prediction-dashboard__market">
        <div class="prediction-dashboard__market-head">
          <div>
            <span>Раздача №{{ state.currentMarket?.handNumber || '—' }}</span>
            <h3>{{ state.currentMarket?.question || 'Следующий прогноз' }}</h3>
          </div>
          <span v-if="state.currentMarket" class="market-status" :data-status="state.currentMarket.status">{{ marketStatusText[state.currentMarket.status] }}</span>
        </div>
        <p class="prediction-dashboard__status">{{ statusText }}</p>
        <p v-if="lockCountdown !== null && state.currentMarket?.status === 'open'" class="prediction-dashboard__countdown">
          Старое окно прогнозов закроется через {{ lockCountdown }} сек. Игра не ждёт.
        </p>

        <div v-if="state.currentMarket?.quotes.length" class="prediction-dashboard__quotes">
          <button
            v-for="quote in state.currentMarket.quotes"
            :key="quote.playerId"
            type="button"
            class="quote-card"
            :class="{ 'quote-card--selected': selectedPlayerId === quote.playerId }"
            :disabled="!quote.available || !state.currentMarket.acceptingBets || Boolean(state.currentBet) || Boolean(waitingFor) || busy"
            @click="selectedPlayerId = quote.playerId"
          >
            <span class="quote-card__seat">Место {{ quote.seat }}</span>
            <strong>{{ quote.playerName }}</strong>
            <span class="quote-card__odds">× {{ quote.odds.toFixed(2) }}</span>
            <span>Игровая оценка {{ Math.round(quote.modelScore * 100) }}%</span>
            <small>{{ quote.reasonCodes.map(code => reasonText[code] || code).join(' · ') || 'равная стартовая оценка' }}</small>
          </button>
        </div>

        <div v-if="state.currentMarket?.pricingMode === 'fixed_odds' && state.currentMarket.status === 'open' && !state.currentBet" class="prediction-dashboard__wait">
          <span>{{ streetNames[state.currentMarket.street] }} · Один прогноз на раздачу</span>
          <template v-if="waitingFor">
            <p>Вы ждёте: {{ streetNames[waitingFor].toLowerCase() }}. Очки не списаны, игра продолжается.</p>
            <button class="btn btn--ghost" :disabled="busy" @click="setWaiting(null)">Поставить сейчас</button>
          </template>
          <button v-else-if="nextStreet" class="btn btn--ghost" :disabled="busy" @click="setWaiting(nextStreet)">{{ waitLabels[nextStreet] }}</button>
        </div>

        <div v-if="state.currentMarket?.acceptingBets && !waitingFor && !state.currentBet && state.maxStake >= state.minStake" class="prediction-dashboard__bet">
          <label>
            <span>Сколько поставить ({{ state.minStake }}–{{ state.maxStake }})</span>
            <input v-model.number="stake" class="input" type="number" :min="state.minStake" :max="state.maxStake">
          </label>
          <button class="btn" type="button" :disabled="!canBet" @click="submitBet">Подтвердить прогноз</button>
        </div>

        <p v-else-if="state.currentMarket?.status === 'open' && !state.currentBet && state.maxStake < state.minStake" class="prediction-dashboard__notice">
          Недостаточно очков для минимального прогноза {{ state.minStake }}.
        </p>

        <div v-if="state.currentBet" class="prediction-dashboard__ticket">
          <span>Ваш прогноз принят</span>
          <strong>{{ state.currentBet.candidateName }} · {{ state.currentBet.stake }} очков</strong>
          <template v-if="state.currentBet.acceptedOdds !== null">
            <strong>Ваш коэффициент ×{{ state.currentBet.acceptedOdds.toFixed(2) }} зафиксирован</strong>
            <span>Выплата при победе: {{ state.currentBet.potentialPayout }} очков, включая ставку</span>
            <small>Новые коэффициенты не меняют вашу выплату. При делёжке вы получите долю чистого выигрыша, а ставка сохранится.</small>
          </template>
          <small>Статус: {{ betStatusText[state.currentBet.status] || state.currentBet.status }}</small>
        </div>
      </section>

      <section class="prediction-dashboard__reentry">
        <div>
          <h3>Вернуться за стол</h3>
          <p v-if="state.pendingReentry">Запрос на {{ state.pendingReentry.amount }} отправлен дилеру.</p>
          <p v-else-if="state.availableProfit < state.comebackMinBuyIn">Нужно заработать ещё {{ state.comebackMinBuyIn - state.availableProfit }} очков чистой прибыли.</p>
          <p v-else>Доступно от {{ state.comebackMinBuyIn }} до {{ Math.min(state.comebackMaxBuyIn, state.availableProfit) }}.</p>
        </div>
        <template v-if="!state.pendingReentry">
          <input v-model.number="reentryAmount" class="input" type="number" :min="state.comebackMinBuyIn" :max="Math.min(state.comebackMaxBuyIn, state.availableProfit)">
          <button class="btn btn--success" type="button" :disabled="!canReenter" @click="submitReentry">Запросить возврат</button>
        </template>
      </section>
    </template>

    <Teleport to="body">
      <transition name="prediction-result-fade">
        <div v-if="resultModal.visible" class="prediction-result-modal" role="status" aria-live="polite">
          <section class="prediction-result-modal__card" :data-tone="resultModal.tone">
            <strong>{{ resultModal.title }}</strong>
            <span>{{ resultModal.amount > 0 ? '+' : '' }}{{ resultModal.amount }}</span>
          </section>
        </div>
      </transition>
    </Teleport>
  </section>
</template>

<style scoped lang="scss">
.prediction-dashboard {
  display: grid;
  gap: 0.85rem;
  padding: 1rem;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(240, 188, 79, 0.34);
  background: radial-gradient(circle at 85% 0%, rgba(240, 188, 79, 0.14), transparent 38%), rgba(7, 24, 20, 0.92);

  h2, h3, p { margin: 0; }
  &__hero { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; p:last-child { margin-top: 0.35rem; color: var(--text-muted); } }
  &__eyebrow { color: var(--accent-strong); font-size: 0.72rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
  &__balance { display: grid; text-align: right; span { color: var(--text-muted); font-size: 0.75rem; } strong { color: var(--accent-strong); font-size: 1.8rem; } }
  &__economy { display: grid; grid-template-columns: 1fr 1fr; gap: 0.55rem; div { display: grid; padding: 0.75rem; border-radius: var(--radius-sm); background: rgba(255,255,255,.05); } span, small { color: var(--text-muted); } b { font-size: 1.15rem; } .profit { color: #77d79b; } }
  &__notice, &__status { padding: 0.7rem; border-radius: var(--radius-sm); color: var(--text-muted); background: rgba(255,255,255,.05); }
  &__market { display: grid; gap: 0.75rem; }
  &__market-head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: flex-start; span { color: var(--text-muted); font-size: .75rem; } }
  &__quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 0.55rem; }
  &__bet, &__reentry { display: grid; grid-template-columns: 1fr auto; gap: 0.65rem; align-items: end; padding: .8rem; border-radius: var(--radius-md); background: rgba(0,0,0,.2); label { display: grid; gap: .3rem; span { color: var(--text-muted); font-size: .8rem; } } }
  &__reentry { grid-template-columns: 1fr minmax(120px, 180px) auto; p { margin-top: .3rem; color: var(--text-muted); } }
  &__ticket { display: grid; gap: .2rem; padding: .8rem; border-radius: var(--radius-md); border: 1px solid rgba(119,215,155,.3); span, small { color: var(--text-muted); } }
  &__wait { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .7rem; padding: .8rem; border: 1px dashed #8ba48d66; border-radius: var(--radius-md); p { flex-basis: 100%; margin: 0; color: var(--text-muted); } }
}
.quote-card { display: grid; gap: .3rem; text-align: left; padding: .75rem; border: 1px solid rgba(255,255,255,.1); border-radius: var(--radius-md); color: var(--text); background: rgba(255,255,255,.04); cursor: pointer; &--selected { border-color: var(--accent-strong); box-shadow: 0 0 0 2px rgba(240,188,79,.12); } &:disabled { opacity: .45; cursor: not-allowed; } &__seat, span, small { color: var(--text-muted); } &__odds { color: var(--accent-strong) !important; font-size: 1.2rem; font-weight: 800; } }
.market-status { padding: .25rem .5rem; border-radius: 999px; background: rgba(255,255,255,.08); text-transform: uppercase; &[data-status="open"] { color: #77d79b; } &[data-status="locked"] { color: var(--accent-strong); } }
.prediction-result-modal { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 1rem; pointer-events: none; }
.prediction-result-modal__card { display: grid; gap: .35rem; min-width: min(320px, 90vw); padding: 1.25rem 1.5rem; border: 1px solid rgba(255,255,255,.18); border-radius: var(--radius-lg); color: var(--text); background: #12241a; box-shadow: 0 18px 60px rgba(0,0,0,.4); text-align: center; strong { font-size: 1.25rem; } span { font-size: 2rem; font-weight: 900; } &[data-tone="win"] span { color: #77d79b; } &[data-tone="loss"] span { color: #ff8c83; } &[data-tone="neutral"] span { color: var(--text-muted); } }
.prediction-result-fade-enter-active, .prediction-result-fade-leave-active { transition: opacity .18s ease, transform .18s ease; }
.prediction-result-fade-enter-from, .prediction-result-fade-leave-to { opacity: 0; transform: translateY(8px) scale(.98); }
@media (max-width: 680px) { .prediction-dashboard { &__hero { align-items: stretch; } &__balance { min-width: 100px; } &__economy { grid-template-columns: 1fr; } &__bet, &__reentry { grid-template-columns: 1fr; align-items: stretch; } } }
</style>
