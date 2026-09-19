<script setup lang="ts">
import AppIcon from '~/components/ui/AppIcon.vue'
import { useAccountStore } from '~/stores/account'
const account = useAccountStore()
const auth = useAccountAuth()
const { preferences } = useGamePreferences()
type Economy = { minesBank: number; rocketBank: number; jackpot: number; participants: Array<{ userId: string; username: string; lost: number; chance: number }> }
type Session = { id: string; status: 'ACTIVE' | 'CASHED_OUT' | 'LOST'; stake: number; mines: number; openedCells: number[]; mineCells?: number[]; safeOpened: number; multiplier: number; potentialPayout: number; payout: number; balance?: number; safeRemaining: number; currentColumn: number; columns: number; nextRisk: number | null; serverSeedHash: string; serverSeed?: string; clientSeed: string; nonce: number; createdAt: string; finishedAt?: string }
type Commitment = { commitmentId: string; serverSeedHash: string; expiresAt: string }
type StartInput = { stake: number; mines: number; clientSeed: string; commitmentId: string; idempotencyKey: string }
const session = ref<Session | null>(null)
const history = ref<Session[]>([])
const commitment = ref<Commitment | null>(null)
const pending = ref<StartInput | null>(null)
const stake = ref(10)
const mines = ref(5)
const clientSeed = ref('')
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const verification = ref('')
const economy = ref<Economy | null>(null)
let balancePoll: number | undefined
const active = computed(() => session.value?.status === 'ACTIVE')
const validStake = computed(() => Number.isSafeInteger(stake.value) && stake.value >= 10 && stake.value <= 100_000)
const headers = computed(() => ({ Authorization: `Bearer ${account.token}` }))
const storageKey = () => `mines-pending:${account.user?.id || 'account'}`
const fmt = (n: number) => n.toLocaleString('ru-RU')
const date = (s: string) => new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
function persist() { try { if (pending.value) localStorage.setItem(storageKey(),JSON.stringify(pending.value)); else localStorage.removeItem(storageKey()) } catch {} }
async function prepare() {
  if (active.value || pending.value) return
  commitment.value = await $fetch<Commitment>('/api/mines/prepare', { method: 'POST', headers: headers.value, retry: 0 })
}
async function load() {
  if (!account.token) { loading.value = false; return }
  try {
    if (!pending.value && account.user?.id) { try { pending.value = JSON.parse(localStorage.getItem(storageKey()) || 'null') } catch {} }
    const result = await $fetch<{ active: Session | null; history: Session[]; balance?: number }>('/api/mines/state', { headers: headers.value })
    history.value = result.history; economy.value = (result as any).economy || economy.value
    if (result.balance !== undefined && account.user) account.setUser({ ...account.user, balance: result.balance })
    if (result.active) { session.value = result.active; pending.value = null; persist() }
    else if (session.value) session.value = result.history.find(s=>s.id===session.value?.id) || session.value
    if (!active.value && !commitment.value && !pending.value) await prepare()
  } catch (e: any) { error.value = e?.data?.statusMessage || 'Не удалось восстановить игру. Проверьте соединение.' }
  finally { loading.value = false }
}
function accept(result: Session) {
  session.value = result
  if (result.balance !== undefined && account.user) account.setUser({ ...account.user, balance: result.balance })
  pending.value = null; persist()
  if (preferences.turnVibration && 'vibrate' in navigator) navigator.vibrate(result.status === 'LOST' ? [80,40,80] : 20)
}
async function run(action: () => Promise<Session>) {
  if (busy.value) return
  busy.value = true; error.value = ''; verification.value = ''
  try { accept(await action()); await auth.loadMe(); if (!active.value) { commitment.value = null; await load() } }
  catch (e: any) { error.value = e?.data?.statusMessage || 'Ответ не получен. Состояние восстановлено; повторный запрос безопасен.'; await load(); await auth.loadMe().catch(()=>{}) }
  finally { busy.value = false }
}
async function start() {
  if (!pending.value) {
    if (!validStake.value || !commitment.value || !clientSeed.value.trim()) return
    if (Date.parse(commitment.value.expiresAt) <= Date.now()) { commitment.value = null; await load(); error.value = 'Хеш обновлён. Проверьте его и нажмите «Начать» ещё раз.'; return }
    pending.value = { stake: stake.value, mines: mines.value, clientSeed: clientSeed.value.trim(), commitmentId: commitment.value.commitmentId, idempotencyKey: crypto.randomUUID() }; persist()
  }
  const input = pending.value
  await run(async () => {
    const result = await $fetch<{ session: Session }>('/api/mines/start', { method: 'POST', retry: 0, headers: headers.value, body: input })
    return result.session
  })
}
async function open(cell: number) {
  if (!active.value || session.value!.openedCells.includes(cell)) return
  const id = session.value!.id
  await run(async () => (await $fetch<{ session: Session }>('/api/mines/open', { method: 'POST', retry: 0, headers: headers.value, body: { sessionId: id, cell } })).session)
}
async function cashout() {
  if (!active.value || !session.value!.safeOpened) return
  const id = session.value!.id
  await run(async () => (await $fetch<{ session: Session }>('/api/mines/cashout', { method: 'POST', retry: 0, headers: headers.value, body: { sessionId: id } })).session)
}
function randomCell() {
  const cells = Array.from({length:25},(_,i)=>i).filter(i=>!session.value?.openedCells.includes(i))
  if (!cells.length || busy.value) return
  // Rejection sampling avoids modulo bias; this does NOT peek at the server field.
  const bound = Math.floor(0x100000000/cells.length)*cells.length
  let n: number
  do { n=crypto.getRandomValues(new Uint32Array(1))[0]! } while(n>=bound)
  void open(cells[n%cells.length]!)
}
async function verify(game: Session) {
  busy.value = true
  try {
    const result = await $fetch<Session & { verified: boolean }>('/api/mines/verify', { headers: headers.value, query: { sessionId: game.id } })
    const encode = (s: string) => new TextEncoder().encode(s)
    const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('')
    const hash = hex(await crypto.subtle.digest('SHA-256',encode(result.serverSeed!)))
    const key = await crypto.subtle.importKey('raw',encode(result.serverSeed!),{name:'HMAC',hash:'SHA-256'},false,['sign'])
    const scores = await Promise.all(Array.from({length:25},async(_,cell)=>({cell,hash:hex(await crypto.subtle.sign('HMAC',key,encode(`${result.clientSeed}:${result.nonce}:${cell}`)))})))
    const field = scores.sort((a,b)=>a.hash<b.hash?-1:a.hash>b.hash?1:a.cell-b.cell).slice(0,result.mines).map(x=>x.cell).sort((a,b)=>a-b)
    verification.value = hash===game.serverSeedHash && JSON.stringify(field)===JSON.stringify(result.mineCells) && result.verified ? '✓ Проверено независимо в браузере: хеш и все мины совпадают.' : 'Проверка не пройдена. Сохраните данные игры и обратитесь к администратору.'
  } catch { verification.value = 'Проверка недоступна. Повторите после восстановления соединения.' }
  finally { busy.value = false }
}
function recover() { if (document.visibilityState === 'visible' && !busy.value) void load() }
watch(() => account.token, () => { if (!busy.value) void load() })
onMounted(() => {
  clientSeed.value = crypto.randomUUID()
  try { pending.value = JSON.parse(localStorage.getItem(storageKey()) || 'null') } catch {}
  void load()
  balancePoll = window.setInterval(() => { if (document.visibilityState === 'visible' && !busy.value) void load() }, 5000)
  window.addEventListener('online',recover); document.addEventListener('visibilitychange',recover)
})
onBeforeUnmount(() => { if (balancePoll) window.clearInterval(balancePoll); window.removeEventListener('online',recover); document.removeEventListener('visibilitychange',recover) })
</script>
<template>
  <section v-if="!account.token" class="panel mines"><h2>Мины</h2><p>Войдите, чтобы играть виртуальными фишками.</p><NuxtLink class="btn" to="/login">Войти</NuxtLink></section>
  <section v-else class="mines">
    <header class="panel heading"><div><small>MINES · ПОЛЕ 5 × 5 · RTP 94%</small><h2>Открывай. Рискуй. Вовремя забирай.</h2><p class="curve-note">Первый безопасный ход даёт небольшой икс, дальше коэффициент растёт по вероятности.</p></div><div class="money"><b>{{ fmt(account.user?.balance || 0) }}</b><small>текущий баланс · live</small><b class="bank">{{ fmt(economy?.minesBank || 0) }}</b><small>банк Mines сегодня</small></div></header>
    <p v-if="loading" role="status">Восстанавливаем игру…</p>
    <section v-if="!active" class="panel setup">
      <label>Ставка · 10–100 000<input v-model.number="stake" class="input" type="number" min="10" max="100000" :disabled="busy || Boolean(pending)"></label><div class="quick"><span>Быстрая ставка</span><button type="button" :disabled="busy || Boolean(pending)" @click="stake=Number(account.user?.balance || 0)">ALL-IN</button><button v-for="amount in [1000,5000,10000]" :key="amount" type="button" :disabled="busy || Boolean(pending)" @click="stake=amount">{{ fmt(amount) }}</button></div>
      <label>Мин на поле · 1–24<input v-model.number="mines" class="input" type="number" min="1" max="24" step="1" :disabled="busy || Boolean(pending)"></label>
      <details v-if="commitment"><summary>Хеш поля до ставки</summary><code>{{ commitment.serverSeedHash }}</code><p>После игры seed раскрывается. Вы сможете независимо проверить все клетки.</p></details>
      <button class="btn" :disabled="busy || loading || (!pending && (!validStake || !commitment || !clientSeed.trim()))" @click="start">{{ busy ? 'Обрабатываем…' : pending ? 'Повторить безопасно' : 'Начать игру' }}</button>
      <button v-if="pending && !busy" class="btn btn--ghost" @click="pending=null; persist(); commitment=null; load()">Изменить параметры (после проверки состояния)</button>
    </section>
    <section v-if="session" class="panel board" :class="{ won: session.status==='CASHED_OUT' }">
      <header class="board-head"><div><small>{{ active ? 'ИГРА ИДЁТ' : session.status==='LOST' ? 'ПОПАДАНИЕ НА МИНУ' : 'ВЫПЛАТА ЗАЧИСЛЕНА' }}</small><h2>{{ session.multiplier.toFixed(4) }}×</h2></div><b>{{ fmt(active ? session.potentialPayout : session.payout) }} фишек</b></header>
      <div class="stats"><span>Прибыль<b>{{ fmt((active ? session.potentialPayout : session.payout)-session.stake) }}</b></span><span>Столбцов осталось<b>{{ session.safeRemaining }}</b></span><span>Риск выбора<b>{{ session.nextRisk===null ? '—' : (session.nextRisk*100).toFixed(0)+'%' }}</b></span></div>
      <div class="grid" aria-label="Поле мин"><button v-for="n in 25" :key="n" :aria-label="`Клетка ${n}`" :class="{ safe: session.openedCells.includes(n-1) && !session.mineCells?.includes(n-1), mine: !active && session.mineCells?.includes(n-1), revealed: !active, hit: session.status==='LOST' && session.openedCells.at(-1)===n-1 }" :disabled="busy || !active || session.openedCells.includes(n-1)" @click="open(n-1)"><AppIcon v-if="!active && session.mineCells?.includes(n-1)" name="mine" :size="22"/><AppIcon v-else-if="session.openedCells.includes(n-1) || !active" name="diamond" :size="18"/><span v-else>·</span></button></div>
      <div v-if="active" class="actions"><button class="btn btn--ghost" :disabled="busy" @click="randomCell">Случайная клетка</button><button class="btn" :disabled="busy || !session.safeOpened" @click="cashout">Забрать {{ fmt(session.potentialPayout) }}</button></div>
      <p v-else role="status">{{ session.status==='LOST' ? 'Ставка проиграна. Поле полностью раскрыто.' : 'Выигрыш уже на балансе.' }}</p>
      <details><summary>Данные честности</summary><code>{{ session.serverSeedHash }}</code><p>Client seed: {{ session.clientSeed }} · nonce {{ session.nonce }}</p><code v-if="!active">{{ session.serverSeed }}</code><p>В каждом из 5 столбцов одинаковое число мин выбирается по HMAC-SHA256. Seed можно проверить после игры.</p><button v-if="!active" class="btn btn--ghost" :disabled="busy" @click="verify(session)">Проверить в браузере</button></details>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="verification" role="status">{{ verification }}</p>
    <section v-if="history.length" class="panel history"><h3>Последние игры</h3><div v-for="game in history" :key="game.id"><span>{{ date(game.createdAt) }}<small>{{ fmt(game.stake) }} · {{ game.mines }} мин · открыто {{ game.safeOpened }} · {{ game.multiplier.toFixed(4) }}×</small></span><b :class="{ loss: game.status==='LOST' }">{{ game.status==='LOST' ? '−'+fmt(game.stake) : '+'+fmt(game.payout-game.stake) }}</b><button :disabled="busy" aria-label="Проверить честность игры" @click="verify(game)">✓</button></div></section>
    <p class="fine">Открытое поле 5×5: выбирайте любую закрытую клетку. Можно выбрать от 1 до 24 мин; чем их больше, тем выше выплата за безопасный выбор.</p>
  </section>
</template>
<style scoped>
.mines{display:grid;gap:1rem}.panel{padding:1.2rem;border-radius:20px;background:#102923}.heading,.board-head{display:flex;justify-content:space-between;gap:1rem;align-items:center}.money{text-align:right}.money b{display:block;color:var(--accent);font-size:1.5rem}.mines h2,.mines h3{margin:.3rem 0}.mines small,.fine{color:var(--text-muted);font-size:.75rem}.setup{display:grid;gap:.8rem}.setup label{display:grid;gap:.4rem}.quick{display:flex;gap:.4rem;flex-wrap:wrap}.quick button{background:#ffffff0c;color:inherit;border:1px solid #ffffff20}.options,.actions{display:flex;gap:.5rem;flex-wrap:wrap}.options button,.history button{padding:.65rem .9rem;border-radius:10px;border:1px solid #ffffff20;background:#ffffff0c;color:inherit;cursor:pointer}.options button.selected{background:var(--accent);color:#142a20}.board{display:grid;gap:1rem}.board h2{font-size:2.7rem;color:var(--accent)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;font-size:.75rem;color:var(--text-muted)}.stats b{display:block;font-size:1rem;color:var(--text-primary);margin-top:.3rem}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem}.grid button{aspect-ratio:1;border:1px solid #ffffff20;border-radius:12px;background:linear-gradient(145deg,#204b3e,#14372c);color:var(--accent);font-size:1.7rem;cursor:pointer;transition:background .15s,transform .15s}.grid button:not(:disabled):hover{transform:translateY(-2px);border-color:var(--accent)}.grid button.safe{background:#b5f36b;color:#193428;animation:reveal .2s ease-out}.grid button.mine{background:#5b2b2b}.grid button.hit{outline:2px solid #ff8b75}.grid button.revealed:not(.safe):not(.mine){opacity:.45}.won{animation:celebrate .5s ease-out}.actions>*{flex:1}.error,.loss{color:#ff8b75}code{display:block;overflow-wrap:anywhere;font-size:.75rem;margin:.6rem 0;color:var(--accent)}details p,.fine{overflow-wrap:anywhere}.history>div{display:grid;grid-template-columns:1fr auto auto;gap:.7rem;align-items:center;padding:.6rem 0;border-bottom:1px solid #ffffff0c}.history small{display:block;margin-top:.25rem}button:disabled{cursor:default;opacity:.55}.grid button:disabled{opacity:1}@keyframes reveal{from{transform:scale(.88)}to{transform:scale(1)}}@keyframes celebrate{50%{box-shadow:0 0 25px #b5f36b55}}@media(max-width:540px){.heading{align-items:flex-start;flex-direction:column}.money{text-align:left}.grid{gap:.35rem}.stats{font-size:.65rem}.panel{padding:.9rem}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.quick span{font-size:.72rem;color:var(--text-muted);width:100%}.quick button{min-width:76px}.quick button:first-of-type{border-color:#e6c57d;color:#f1d79d;background:#e6c57d15}.setup>.quick{align-items:center}.setup>.quick button{flex:0 0 auto}.setup>.btn{min-height:46px}@media(max-width:540px){.quick button{flex:1}}

/* Mines visual polish and compact mobile layout. */
.mines{--mine-gold:#edc782;--mine-mint:#a8e6c3;position:relative}.mines:before{content:"";position:absolute;z-index:-1;inset:-70px 0 auto;height:340px;pointer-events:none;background:radial-gradient(circle,#3c906c1e,transparent 65%)}.panel{border:1px solid #a8ddc022;background:linear-gradient(145deg,#112e25,#0c241d);box-shadow:0 18px 52px #0003,inset 0 1px #fff1}.heading{position:relative;overflow:hidden;padding:22px 24px}.heading:after{content:"";position:absolute;right:-60px;top:-100px;width:260px;height:260px;border:1px solid #9ae0bd1f;border-radius:50%;box-shadow:0 0 0 32px #9ae0bd08,0 0 0 65px #9ae0bd05;pointer-events:none}.heading>div:first-child{position:relative;z-index:1;max-width:67%}.heading h2{font-size:clamp(1.35rem,4vw,2rem);line-height:1.15;letter-spacing:-.035em}.curve-note{max-width:520px;margin:.7rem 0 0;color:#91aa9e;font-size:.76rem;line-height:1.55}.money{position:relative;z-index:1;min-width:180px;padding:13px 15px;border:1px solid #ffffff12;border-radius:16px;background:#071d1799;backdrop-filter:blur(9px)}.money b{font-size:1.35rem;line-height:1}.money small{display:block;margin:4px 0 11px;line-height:1.35}.money small:last-child{margin-bottom:0}.money .bank{padding-top:10px;border-top:1px solid #ffffff10;color:var(--mine-gold);font-size:1.05rem}
.setup{gap:14px;padding:20px}.setup>label{gap:8px;padding:14px;border:1px solid #ffffff10;border-radius:15px;background:#071d1766;color:#a6bbae;font-size:.74rem}.input{box-sizing:border-box;width:100%;min-height:48px;padding:12px 13px;border:1px solid #ffffff1e;border-radius:12px;outline:0;background:#061a15;color:#f0f5f1;font:inherit;font-size:1rem;font-weight:750;transition:.2s}.input:focus{border-color:#a6e6c270;box-shadow:0 0 0 3px #a6e6c210}.quick{padding:2px}.quick span{font-size:.58rem;letter-spacing:.11em}.quick button{min-height:40px;padding:8px 13px;border-radius:11px;font-weight:750;transition:.2s}.quick button:hover{border-color:#e7c98665;background:#e7c98612}.setup details,.board details{padding:13px 14px;border:1px solid #ffffff10;border-radius:13px;background:#071d1766}.setup summary,.board summary{color:#b9cbbf;font-size:.75rem;cursor:pointer}.setup>.btn{width:100%;min-height:52px;border-radius:14px;background:linear-gradient(110deg,#f2d393,#cfa65e);box-shadow:0 10px 28px #d7b36a1c;color:#17251d;font-weight:850}.setup>.btn--ghost{background:#ffffff08;box-shadow:none;color:#c9d9d0}
.board{position:relative;gap:16px;padding:20px;overflow:hidden}.board:before{content:"";position:absolute;right:-90px;top:-110px;width:280px;height:280px;border-radius:50%;background:#82dfb315;filter:blur(10px);pointer-events:none}.board-head{position:relative;z-index:1;padding-bottom:14px;border-bottom:1px solid #ffffff0e}.board-head>div small{letter-spacing:.12em}.board-head h2{font-size:clamp(2.5rem,9vw,4.5rem);line-height:1;letter-spacing:-.05em}.board-head>b{padding:10px 13px;border:1px solid #ffffff12;border-radius:12px;background:#071d1788;color:#dfeae4;font-size:.85rem}.stats{position:relative;z-index:1;gap:8px}.stats span{min-width:0;padding:11px 12px;border:1px solid #ffffff0d;border-radius:12px;background:#ffffff07;line-height:1.35}.stats b{overflow-wrap:anywhere}.grid{position:relative;z-index:1;gap:8px;padding:10px;border:1px solid #ffffff0e;border-radius:18px;background:#061a1577}.grid button{border-radius:14px;box-shadow:inset 0 1px #ffffff10,0 7px 14px #0002;transition:transform .18s,border-color .18s,filter .18s}.grid button:not(:disabled):hover{transform:translateY(-3px);filter:brightness(1.08)}.grid button.safe{box-shadow:inset 0 1px #fff7,0 0 22px #b5f36b24}.actions{position:relative;z-index:1}.actions .btn{min-height:48px;border-radius:13px;font-weight:800}.history{padding:18px 20px}.history h3{margin-bottom:10px}.history>div{padding:10px 0}.history>div>span{min-width:0;overflow-wrap:anywhere}.history>div>b{white-space:nowrap}.history>div>button{width:38px;height:38px;padding:0}.fine{padding:0 6px;line-height:1.55}
@media(max-width:540px){.mines{gap:12px}.heading{gap:15px;padding:17px;align-items:stretch}.heading>div:first-child{max-width:none}.heading h2{font-size:1.55rem}.curve-note{font-size:.72rem}.money{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;min-width:0;text-align:left}.money b,.money small{margin:0}.money b{font-size:1.2rem}.money small{font-size:.62rem}.money .bank{padding-top:0;border-top:0;font-size:1.2rem}.setup{padding:15px}.setup>label{padding:12px}.quick{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.quick span{grid-column:1/-1}.setup>.quick button{min-width:0;width:100%}.board{padding:13px;border-radius:19px}.board-head{align-items:flex-start;gap:8px}.board-head h2{font-size:2.7rem}.board-head>b{max-width:42%;text-align:right;font-size:.72rem;overflow-wrap:anywhere}.stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.stats span{padding:8px 7px;font-size:.58rem}.stats b{font-size:.8rem}.grid{gap:5px;padding:6px;border-radius:14px}.grid button{border-radius:10px;font-size:clamp(1rem,6vw,1.45rem)}.actions{display:grid;grid-template-columns:1fr;gap:8px}.history{padding:15px}.history>div{grid-template-columns:minmax(0,1fr) auto auto;gap:8px}.history small{font-size:.65rem;line-height:1.45}.history>div>b{font-size:.8rem}}
@media(max-width:360px){.money{grid-template-columns:1fr}.money small{margin-bottom:5px}.board-head{display:grid}.board-head>b{max-width:none;text-align:left}.stats{grid-template-columns:1fr}.stats span{display:flex;justify-content:space-between;align-items:center}.stats b{margin:0}.grid{gap:4px;padding:5px}}
</style>
