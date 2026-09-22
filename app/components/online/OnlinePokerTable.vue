<script setup lang="ts">
import type { OnlineAction, OnlineConnectionStatus, OnlineHandPlayer, OnlineRoomState, OnlineTablePlayer } from '~/types/online'
import { cardIsRed, cardLabel, displayHand, formatTurnSeconds, isPostHandWaitingState, isViewerActor, ownHoleCards, playerForViewer, remainingTurnSeconds, seatPosition, tablePlayerForViewer, toCall } from '~/utils/onlineRoomUi'

const props = defineProps<{
  state: OnlineRoomState
  viewerId: string | null
  connectionStatus: OnlineConnectionStatus
  pendingActionId?: string | null
  notice?: string
  canStart?: boolean
  ready?: boolean
  sittingOut?: boolean
}>()

const emit = defineEmits<{
  action: [action: OnlineAction]
  start: []
  ready: [value: boolean]
  sittingOut: [value: boolean]
  leave: []
  reconnect: []
}>()

const now = ref(Date.now())
const amount = ref<number | null>(null)
let countdownTimer: ReturnType<typeof setInterval> | undefined

const hand = computed(() => props.state.pokerTable.currentHand)
const visibleHand = computed(() => displayHand(hand.value))
const tableViewer = computed(() => tablePlayerForViewer(props.state.pokerTable, props.viewerId))
const viewer = computed(() => playerForViewer(hand.value, props.viewerId))
const viewerIsActor = computed(() => isViewerActor(hand.value, props.viewerId))
const canAct = computed(() => viewerIsActor.value && props.connectionStatus === 'connected')
const viewerToCall = computed(() => toCall(hand.value, props.viewerId))
const isPending = computed(() => Boolean(props.pendingActionId))
const deadlineSeconds = computed(() => remainingTurnSeconds(visibleHand.value?.turnDeadlineAt ?? null, now.value))
const actor = computed(() => visibleHand.value?.players.find(player => player.seat === visibleHand.value?.currentActor) ?? null)
const actorTablePlayer = computed(() => actor.value ? props.state.pokerTable.players.find(player => player.playerId === actor.value?.playerId) ?? null : null)
const ownCards = computed(() => ownHoleCards(visibleHand.value, props.viewerId))
const handStrength = computed(() => visibleHand.value?.handStrength ?? null)
const displayPlayers = computed(() => {
  const players = [...props.state.pokerTable.players]
  const viewerIndex = props.viewerId ? players.findIndex(player => player.playerId === props.viewerId) : -1
  if (viewerIndex <= 0) return players
  const [viewer] = players.splice(viewerIndex, 1)
  return viewer ? [viewer, ...players] : players
})
const callAmount = computed(() => Math.min(viewerToCall.value, viewer.value?.stack ?? 0))
const maxTargetAmount = computed(() => (viewer.value?.streetContribution ?? 0) + (viewer.value?.stack ?? 0))
const isWaiting = computed(() => isPostHandWaitingState(props.state))

watch(() => [props.state.pokerTable.stateVersion, hand.value?.currentActor, hand.value?.street], () => {
  amount.value = null
})

onMounted(() => { countdownTimer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })

function send(type: OnlineAction['type']) {
  if (!viewerIsActor.value || isPending.value) return
  if (type === 'bet' || type === 'raise') {
    const value = Number(amount.value)
    if (!Number.isSafeInteger(value) || value <= 0) return
    emit('action', { type, amount: value })
    return
  }
  emit('action', { type })
}

function handPlayer(playerId: string): OnlineHandPlayer | null {
  return visibleHand.value?.players.find(item => item.playerId === playerId) ?? null
}

function displayName(player: OnlineTablePlayer): string {
  return player.nickname?.trim() || `Игрок ${player.seat}`
}

function cardId(card: { rank: string; suit: string }): string {
  return `${card.rank}:${card.suit}`
}

function isContributingCard(card: { rank: string; suit: string }): boolean {
  return Boolean(handStrength.value?.contributingCardIds.includes(cardId(card)))
}

function statusLabel(player: OnlineTablePlayer, hand: OnlineHandPlayer | null): string {
  if (hand?.status === 'FOLDED') return 'Сбросил карты'
  if (hand?.status === 'ALL_IN') return 'Ва-банк'
  if (hand?.status === 'OUT' || player.sittingOut) return 'Вне игры'
  if (!player.connected) return 'Отключён'
  return 'В игре'
}

function actionLabel(action: OnlineHandPlayer['lastAction']): string {
  return action === 'check' ? 'Чек' : action === 'call' ? 'Колл' : action === 'bet' ? 'Ставка' : action === 'raise' ? 'Рейз' : action === 'fold' ? 'Фолд' : action === 'all-in' ? 'Олл-ин' : ''
}

function connectionLabel(status: OnlineConnectionStatus): string {
  return {
    loading: 'Подключаемся…', connecting: 'Подключаемся…', connected: 'За столом', reconnecting: 'Переподключение…',
    unauthorized: 'Нужен вход', 'not-found': 'Стол не найден', unavailable: 'Сервис недоступен', error: 'Нет связи', disconnected: 'Нет связи'
  }[status]
}

function cardBacks(playerId: string): boolean {
  return Boolean(visibleHand.value && visibleHand.value.street !== 'SHOWDOWN' && playerId !== props.viewerId && visibleHand.value.players.find(player => player.playerId === playerId)?.status === 'ACTIVE')
}
</script>

<template>
  <main class="online-table-page">
    <header class="online-header">
      <div>
        <NuxtLink class="back-link" to="/rooms">← Столы</NuxtLink>
        <h1>ONLINE · {{ state.roomCode }}</h1>
        <p>{{ state.visibility === 'PRIVATE' ? 'Приватный стол' : 'Публичный стол' }} · {{ state.pokerTable.players.length }}/{{ state.maxPlayers }}</p>
      </div>
      <div class="header-actions">
        <span class="connection" :class="`connection--${connectionStatus}`" role="status">● {{ connectionLabel(connectionStatus) }}</span>
        <button class="icon-button" type="button" aria-label="Выйти из комнаты" @click="emit('leave')">Выйти</button>
      </div>
    </header>

    <p v-if="notice" class="notice" role="status" aria-live="polite">{{ notice }}</p>

    <section class="table-wrap" aria-label="Покерный стол">
      <div class="felt">
        <div class="table-meta">
          <span v-if="visibleHand">{{ visibleHand.street }}</span>
          <span v-else>Ожидание игроков</span>
          <strong v-if="visibleHand">Банк {{ visibleHand.pot }}</strong>
        </div>
        <div class="board" aria-label="Общие карты">
          <span v-for="(card, index) in visibleHand?.board || []" :key="`${card.rank}-${card.suit}-${index}`" class="card" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card) }">{{ cardLabel(card) }}</span>
          <span v-if="!visibleHand?.board.length" class="board-empty">Общие карты появятся здесь</span>
        </div>
        <div v-if="visibleHand" class="pot-pill">POT {{ visibleHand.pot }}</div>
        <div class="players" aria-label="Игроки">
          <article
            v-for="(player, index) in displayPlayers"
            :key="player.playerId"
            class="player-seat"
            :class="{
              'player-seat--self': player.playerId === viewerId,
              'player-seat--actor': visibleHand?.currentActor === player.seat,
              'player-seat--offline': !player.connected,
              'player-seat--folded': handPlayer(player.playerId)?.status === 'FOLDED',
              'player-seat--all-in': handPlayer(player.playerId)?.status === 'ALL_IN',
              'player-seat--sitting-out': player.sittingOut
            }"
            :style="seatPosition(index, displayPlayers.length)"
          >
            <div class="avatar" aria-hidden="true">{{ displayName(player).slice(0, 1).toUpperCase() }}</div>
            <div class="player-info">
              <strong :title="displayName(player)">{{ displayName(player) }}</strong>
              <span>Стек: {{ handPlayer(player.playerId)?.stack ?? player.stack }}</span>
              <small v-if="visibleHand" class="player-bet">Ставка: {{ handPlayer(player.playerId)?.streetContribution ?? 0 }}</small>
              <small v-if="handPlayer(player.playerId)?.lastAction" class="player-action">{{ actionLabel(handPlayer(player.playerId)?.lastAction ?? null) }}</small>
              <small class="player-status">{{ statusLabel(player, handPlayer(player.playerId)) }}</small>
            </div>
            <div class="seat-markers" aria-label="Роли за столом">
              <span v-if="visibleHand?.dealerSeat === player.seat" class="seat-marker" title="Кнопка дилера">D</span>
              <span v-if="visibleHand?.smallBlindSeat === player.seat" class="seat-marker seat-marker--blind" title="Малый блайнд">SB</span>
              <span v-if="visibleHand?.bigBlindSeat === player.seat" class="seat-marker seat-marker--blind" title="Большой блайнд">BB</span>
            </div>
            <div v-if="handPlayer(player.playerId)?.holeCards.length" class="mini-cards">
              <span v-for="card in handPlayer(player.playerId)?.holeCards || []" :key="`${card.rank}-${card.suit}`" class="mini-card" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card) }">{{ cardLabel(card) }}</span>
            </div>
            <div v-else-if="cardBacks(player.playerId)" class="mini-cards mini-cards--back" aria-label="Закрытые карты"><span class="mini-card">★</span><span class="mini-card">★</span></div>
          </article>
        </div>
      </div>
    </section>

    <section v-if="ownCards.length" class="own-cards panel" aria-label="Ваши карты">
      <span class="section-kicker">ВАШИ КАРТЫ</span>
      <div class="own-cards__list"><span v-for="card in ownCards" :key="`${card.rank}-${card.suit}`" class="card card--large" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card) }">{{ cardLabel(card) }}</span></div>
    </section>

    <section class="controls panel">
      <div class="control-row">
        <div>
          <span class="section-kicker">СТОЛ</span>
          <strong v-if="visibleHand?.currentActor !== null && visibleHand?.currentActor !== undefined">Ход: {{ actor?.playerId === viewerId ? 'ваш' : actorTablePlayer ? displayName(actorTablePlayer) : 'игрока' }}</strong>
          <strong v-else-if="visibleHand">Раунд завершён</strong>
          <strong v-else>Готовы начать</strong>
          <small v-if="deadlineSeconds !== null">Таймер {{ formatTurnSeconds(deadlineSeconds) }}</small>
        </div>
        <div class="blind-info">SB {{ state.pokerTable.smallBlind }} · BB {{ state.pokerTable.bigBlind }}</div>
      </div>

      <div v-if="handStrength" class="hand-strength" aria-live="polite">
        <span class="section-kicker">ВАША КОМБИНАЦИЯ</span>
        <strong>{{ handStrength.label }}</strong>
      </div>

      <div v-if="isWaiting && tableViewer" class="waiting-controls">
        <button v-if="canStart" class="btn" type="button" @click="emit('start')">Начать раздачу</button>
        <p v-else>Ожидаем готовых игроков и владельца стола.</p>
        <button class="btn btn--ghost" type="button" @click="emit('ready', !ready)">{{ ready ? 'Отменить готовность' : 'Я готов' }}</button>
        <button class="btn btn--ghost" type="button" @click="emit('sittingOut', !sittingOut)">{{ sittingOut ? 'Вернуться в игру' : 'Сесть вне игры' }}</button>
      </div>

      <div v-else-if="canAct" class="action-grid" aria-label="Действия игрока">
        <button v-if="viewerToCall === 0" class="btn" type="button" :disabled="isPending" @click="send('check')">Чек</button>
        <button v-else class="btn" type="button" :disabled="isPending" @click="send('call')">Колл · {{ callAmount }}</button>
        <label v-if="visibleHand?.currentBet === 0 || visibleHand?.currentBet" class="amount-control">
          <span>Сумма</span>
        <input v-model.number="amount" class="input" type="number" min="1" :max="maxTargetAmount || 1" inputmode="numeric" placeholder="Итоговая ставка">
        </label>
        <button class="btn" type="button" :disabled="isPending || amount === null" @click="send(visibleHand?.currentBet ? 'raise' : 'bet')">{{ visibleHand?.currentBet ? 'Рейз' : 'Бет' }}</button>
        <button class="btn btn--danger" type="button" :disabled="isPending" @click="send('fold')">Фолд</button>
        <button class="btn btn--success" type="button" :disabled="isPending" @click="send('all-in')">Ва-банк · {{ viewer?.stack || 0 }}</button>
      </div>
      <p v-else-if="viewerIsActor && connectionStatus !== 'connected'" class="waiting">{{ connectionLabel(connectionStatus) }}</p>
      <p v-else-if="visibleHand" class="waiting">Ожидаем ход другого игрока.</p>
      <p v-else class="waiting">Подключите игрока к столу, чтобы начать.</p>
    </section>

    <button v-if="connectionStatus === 'reconnecting' || connectionStatus === 'error' || connectionStatus === 'unavailable'" class="btn btn--ghost reconnect-button" type="button" @click="emit('reconnect')">Переподключиться</button>
  </main>
</template>

<style scoped lang="scss">
.online-table-page { max-width: 980px; margin: 0 auto; display: grid; gap: .8rem; padding: .7rem .7rem calc(1.25rem + env(safe-area-inset-bottom)); }
.online-header { display: flex; justify-content: space-between; align-items: flex-start; gap: .7rem; }
.online-header h1 { margin: .2rem 0 0; font: 700 clamp(1.25rem, 5vw, 1.8rem) 'Space Grotesk', sans-serif; }
.online-header p { margin: .25rem 0 0; color: var(--text-muted); font-size: .82rem; }
.back-link { color: var(--accent-strong); font-size: .8rem; }
.header-actions { display: grid; gap: .45rem; justify-items: end; }
.connection { font-size: .72rem; color: var(--success); white-space: nowrap; }
.connection--reconnecting, .connection--connecting, .connection--loading { color: var(--accent-strong); }
.connection--error, .connection--unauthorized, .connection--not-found, .connection--unavailable { color: var(--danger); }
.icon-button { border: 1px solid rgba(255,255,255,.16); border-radius: .65rem; padding: .38rem .55rem; color: var(--text-muted); background: transparent; cursor: pointer; font-size: .75rem; }
.notice { margin: 0; padding: .55rem .7rem; border-radius: .7rem; color: var(--accent-strong); background: rgba(242,180,81,.12); font-size: .85rem; }
.table-wrap { min-height: 360px; }
.felt { position: relative; isolation: isolate; min-height: 390px; overflow: hidden; border: 9px solid #70461e; border-radius: 48%; background: radial-gradient(ellipse at center, #1a744b 0%, #0c442d 60%, #092b20 100%); box-shadow: inset 0 0 0 3px rgba(255,255,255,.08), 0 18px 35px rgba(0,0,0,.28); }
.table-meta { position: absolute; z-index: 1; top: 18%; left: 50%; transform: translateX(-50%); display: flex; gap: .55rem; align-items: center; color: rgba(255,255,255,.75); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
.table-meta strong { color: var(--accent-strong); letter-spacing: 0; text-transform: none; font-size: .9rem; }
.board { position: absolute; z-index: 1; top: 38%; left: 50%; display: flex; justify-content: center; gap: .3rem; min-height: 52px; transform: translate(-50%, -50%); }
.card, .mini-card { display: grid; place-items: center; color: #15221b; background: #f7f4ea; border-radius: .38rem; font-weight: 700; box-shadow: 0 3px 8px rgba(0,0,0,.25); }
.card { width: 38px; height: 52px; font-size: .85rem; }
.card--large { width: 58px; height: 80px; font-size: 1.2rem; }
.card--red { color: #bd3d38; }
.card--gold { border-color: #f2b451; box-shadow: 0 0 0 2px rgba(242,180,81,.82), 0 0 15px rgba(242,180,81,.52); }
.board-empty { color: rgba(255,255,255,.54); font-size: .72rem; white-space: nowrap; align-self: center; }
.pot-pill { position: absolute; z-index: 1; top: 57%; left: 50%; transform: translateX(-50%); color: var(--accent-strong); font-weight: 700; font-size: .9rem; }
.players { position: absolute; z-index: 4; inset: 0; pointer-events: none; }
.player-seat { position: absolute; z-index: 5; width: 112px; min-width: 0; padding: .35rem; border: 1px solid rgba(255,255,255,.18); border-radius: .65rem; transform: translate(-50%, -50%); background: rgba(9,27,20,.94); font-size: .68rem; transition: border-color .15s, box-shadow .15s; pointer-events: auto; }
.player-seat--self { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(242,180,81,.22); }
.player-seat--actor { border-color: var(--accent-strong); box-shadow: 0 0 0 2px rgba(242,180,81,.3); }
.player-seat--offline, .player-seat--folded, .player-seat--sitting-out { opacity: .55; }
.player-seat--all-in { border-color: #d97f54; }
.avatar { float: left; display: grid; place-items: center; width: 25px; height: 25px; margin-right: .28rem; border-radius: 50%; color: #172116; background: var(--accent); font-weight: 700; }
.player-info { min-width: 0; display: grid; gap: .05rem; }
.player-info strong, .player-info span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.player-info span { color: var(--text-muted); }
.player-info small { color: var(--text-muted); }
.player-info .player-bet { color: var(--accent-strong); font-weight: 700; }
.player-info .player-action { color: #f5d88c; font-weight: 700; }
.player-status { font-size: .62rem; }
.seat-markers { position: absolute; top: -.45rem; right: -.35rem; display: flex; gap: .18rem; }
.seat-marker { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 .18rem; border-radius: 50%; color: #1d271d; background: #f2e7bb; font-size: .58rem; font-weight: 700; }
.seat-marker--blind { border-radius: .35rem; background: #c3dfd1; }
.mini-cards { display: flex; gap: .2rem; margin-top: .25rem; }
.mini-card { width: 22px; height: 28px; font-size: .55rem; }
.mini-cards--back .mini-card { color: #f5d88c; background: repeating-linear-gradient(135deg, #293e70, #293e70 3px, #16274f 3px, #16274f 6px); }
.panel { padding: .8rem; }
.own-cards { display: grid; gap: .4rem; justify-items: center; }
.section-kicker { display: block; color: var(--text-muted); font-size: .65rem; letter-spacing: .12em; }
.own-cards__list { display: flex; gap: .4rem; }
.hand-strength { display: grid; gap: .16rem; justify-items: center; padding: .5rem .7rem; border: 1px solid rgba(242,180,81,.36); border-radius: .7rem; background: rgba(242,180,81,.08); text-align: center; }
.hand-strength strong { color: var(--accent-strong); font-size: 1.05rem; }
.controls { display: grid; gap: .7rem; }
.control-row { display: flex; justify-content: space-between; gap: .6rem; align-items: center; }
.control-row strong, .control-row small { display: block; }
.control-row small { color: var(--accent-strong); margin-top: .2rem; }
.blind-info { color: var(--text-muted); font-size: .75rem; }
.waiting-controls { display: grid; gap: .5rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.waiting-controls p { grid-column: 1 / -1; margin: 0; color: var(--text-muted); font-size: .82rem; }
.action-grid { display: grid; gap: .5rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.amount-control { grid-column: 1 / -1; display: grid; gap: .2rem; color: var(--text-muted); font-size: .75rem; }
.action-grid button, .waiting-controls button { min-height: 46px; }
.waiting { margin: 0; color: var(--text-muted); font-size: .85rem; }
.reconnect-button { justify-self: center; }
@media (min-width: 700px) { .online-table-page { padding: 1.2rem 1rem 2rem; } .felt { min-height: 520px; } .player-seat { width: 145px; padding: .5rem; font-size: .78rem; } .card { width: 48px; height: 68px; font-size: 1rem; } .card--large { width: 70px; height: 96px; } .action-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .amount-control { grid-column: span 2; } }
@media (max-width: 400px) { .felt { min-height: 345px; border-width: 6px; } .player-seat { width: 94px; font-size: .6rem; } .avatar { width: 21px; height: 21px; } .card { width: 31px; height: 44px; font-size: .72rem; } .board { gap: .18rem; } .seat-marker { min-width: 18px; font-size: .5rem; } }
</style>
