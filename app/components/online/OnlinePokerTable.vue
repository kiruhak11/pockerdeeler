<script setup lang="ts">
import type { OnlineAction, OnlineConnectionStatus, OnlineRoomState } from '~/types/online'
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
const ownCards = computed(() => ownHoleCards(visibleHand.value, props.viewerId))
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

function statusLabel(status: string): string {
  return status === 'FOLDED' ? 'Сбросил карты' : status === 'ALL_IN' ? 'Ва-банк' : status === 'OUT' ? 'Выбыл' : ''
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
          <span v-for="(card, index) in visibleHand?.board || []" :key="`${card.rank}-${card.suit}-${index}`" class="card" :class="{ 'card--red': cardIsRed(card) }">{{ cardLabel(card) }}</span>
          <span v-if="!visibleHand?.board.length" class="board-empty">Общие карты появятся здесь</span>
        </div>
        <div v-if="visibleHand" class="pot-pill">POT {{ visibleHand.pot }}</div>
        <div class="players" aria-label="Игроки">
          <article
            v-for="(player, index) in state.pokerTable.players"
            :key="player.playerId"
            class="player-seat"
            :class="{
              'player-seat--self': player.playerId === viewerId,
              'player-seat--actor': visibleHand?.currentActor === player.seat,
              'player-seat--offline': !player.connected,
              'player-seat--folded': visibleHand?.players.find(item => item.playerId === player.playerId)?.status === 'FOLDED'
            }"
            :style="seatPosition(index, state.pokerTable.players.length)"
          >
            <div class="avatar" aria-hidden="true">{{ player.seat }}</div>
            <div class="player-info">
              <strong>{{ player.playerId === viewerId ? 'Вы' : `Игрок ${player.seat}` }}</strong>
              <span>{{ visibleHand?.players.find(item => item.playerId === player.playerId)?.stack ?? player.stack }} фишек</span>
              <small v-if="!player.connected">Отключён</small>
              <small v-else-if="visibleHand?.players.find(item => item.playerId === player.playerId)" class="player-status">{{ statusLabel(visibleHand?.players.find(item => item.playerId === player.playerId)?.status || '') }}</small>
            </div>
            <span v-if="visibleHand?.dealerSeat === player.seat" class="dealer-marker" title="Кнопка дилера">D</span>
            <div v-if="visibleHand?.players.find(item => item.playerId === player.playerId)?.holeCards.length" class="mini-cards">
              <span v-for="card in visibleHand?.players.find(item => item.playerId === player.playerId)?.holeCards || []" :key="`${card.rank}-${card.suit}`" class="mini-card" :class="{ 'card--red': cardIsRed(card) }">{{ cardLabel(card) }}</span>
            </div>
            <div v-else-if="cardBacks(player.playerId)" class="mini-cards mini-cards--back" aria-label="Закрытые карты"><span class="mini-card">★</span><span class="mini-card">★</span></div>
          </article>
        </div>
      </div>
    </section>

    <section v-if="ownCards.length" class="own-cards panel" aria-label="Ваши карты">
      <span class="section-kicker">ВАШИ КАРТЫ</span>
      <div class="own-cards__list"><span v-for="card in ownCards" :key="`${card.rank}-${card.suit}`" class="card card--large" :class="{ 'card--red': cardIsRed(card) }">{{ cardLabel(card) }}</span></div>
    </section>

    <section class="controls panel">
      <div class="control-row">
        <div>
          <span class="section-kicker">СТОЛ</span>
          <strong v-if="visibleHand?.currentActor !== null && visibleHand?.currentActor !== undefined">Ход: {{ actor?.playerId === viewerId ? 'ваш' : `игрока ${actor?.seat}` }}</strong>
          <strong v-else-if="visibleHand">Раунд завершён</strong>
          <strong v-else>Готовы начать</strong>
          <small v-if="deadlineSeconds !== null">Таймер {{ formatTurnSeconds(deadlineSeconds) }}</small>
        </div>
        <div class="blind-info">SB {{ state.pokerTable.smallBlind }} · BB {{ state.pokerTable.bigBlind }}</div>
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
.felt { position: relative; min-height: 390px; overflow: hidden; border: 9px solid #70461e; border-radius: 48%; background: radial-gradient(ellipse at center, #1a744b 0%, #0c442d 60%, #092b20 100%); box-shadow: inset 0 0 0 3px rgba(255,255,255,.08), 0 18px 35px rgba(0,0,0,.28); }
.table-meta { position: absolute; top: 18%; left: 50%; transform: translateX(-50%); display: flex; gap: .55rem; align-items: center; color: rgba(255,255,255,.75); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
.table-meta strong { color: var(--accent-strong); letter-spacing: 0; text-transform: none; font-size: .9rem; }
.board { position: absolute; top: 38%; left: 50%; display: flex; justify-content: center; gap: .3rem; min-height: 52px; transform: translate(-50%, -50%); }
.card, .mini-card { display: grid; place-items: center; color: #15221b; background: #f7f4ea; border-radius: .38rem; font-weight: 700; box-shadow: 0 3px 8px rgba(0,0,0,.25); }
.card { width: 38px; height: 52px; font-size: .85rem; }
.card--large { width: 58px; height: 80px; font-size: 1.2rem; }
.card--red { color: #bd3d38; }
.board-empty { color: rgba(255,255,255,.54); font-size: .72rem; white-space: nowrap; align-self: center; }
.pot-pill { position: absolute; top: 57%; left: 50%; transform: translateX(-50%); color: var(--accent-strong); font-weight: 700; font-size: .9rem; }
.players { position: absolute; inset: 0; }
.player-seat { position: absolute; width: 112px; padding: .35rem; border: 1px solid rgba(255,255,255,.18); border-radius: .65rem; transform: translate(-50%, -50%); background: rgba(9,27,20,.88); font-size: .68rem; transition: border-color .15s, box-shadow .15s; }
.player-seat--self { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(242,180,81,.22); }
.player-seat--actor { border-color: var(--accent-strong); box-shadow: 0 0 0 2px rgba(242,180,81,.3); }
.player-seat--offline, .player-seat--folded { opacity: .55; }
.avatar { float: left; display: grid; place-items: center; width: 25px; height: 25px; margin-right: .28rem; border-radius: 50%; color: #172116; background: var(--accent); font-weight: 700; }
.player-info { min-width: 0; display: grid; gap: .05rem; }
.player-info strong, .player-info span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.player-info span { color: var(--text-muted); }
.player-info small { color: var(--danger); }
.dealer-marker { position: absolute; top: -.4rem; right: -.35rem; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: #1d271d; background: #f2e7bb; font-size: .65rem; font-weight: 700; }
.mini-cards { display: flex; gap: .2rem; margin-top: .25rem; }
.mini-card { width: 22px; height: 28px; font-size: .55rem; }
.mini-cards--back .mini-card { color: #f5d88c; background: repeating-linear-gradient(135deg, #293e70, #293e70 3px, #16274f 3px, #16274f 6px); }
.panel { padding: .8rem; }
.own-cards { display: grid; gap: .4rem; justify-items: center; }
.section-kicker { display: block; color: var(--text-muted); font-size: .65rem; letter-spacing: .12em; }
.own-cards__list { display: flex; gap: .4rem; }
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
@media (max-width: 400px) { .felt { min-height: 345px; border-width: 6px; } .player-seat { width: 93px; font-size: .6rem; } .avatar { width: 21px; height: 21px; } .card { width: 31px; height: 44px; font-size: .72rem; } .board { gap: .18rem; } }
</style>
