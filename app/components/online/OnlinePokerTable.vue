<script setup lang="ts">
import OnlineFriendInviteModal from '~/components/online/OnlineFriendInviteModal.vue'
import type { OnlineAction, OnlineCard, OnlineConnectionStatus, OnlineHandPlayer, OnlineRoomState, OnlineTablePlayer, OnlineFinalizedShowdownPlayer } from '~/types/online'
import { cardIsRed, cardLabel, displayHand, isPostHandWaitingState, isShowdownWinningCard, isViewerActor, ownHoleCards, playerForViewer, seatPosition, tablePlayerForViewer, toCall } from '~/utils/onlineRoomUi'

const props = defineProps<{
  state: OnlineRoomState
  viewerId: string | null
  spectating?: boolean
  spectatorCount?: number
  joinBusy?: boolean
  connectionStatus: OnlineConnectionStatus
  pendingActionId?: string | null
  notice?: string
  canStart?: boolean
  ready?: boolean
  sittingOut?: boolean
  walletBalance?: number
  stackOperationBusy?: boolean
  stackOperationResultKey?: number
}>()

const emit = defineEmits<{
  action: [action: OnlineAction]
  start: []
  ready: [value: boolean]
  sittingOut: [value: boolean]
  leave: []
  join: []
  reconnect: []
  stackOperation: [payload: { direction: 'ADD' | 'WITHDRAW'; amount: number; requestKey: string }]
}>()

const amount = ref<number | null>(null)
const stackAction = ref<'ADD' | 'WITHDRAW' | null>(null)
const stackAmount = ref<number | null>(null)
const stackRequestKey = ref<string | null>(null)

const hand = computed(() => props.state.pokerTable.currentHand)
const visibleHand = computed(() => displayHand(hand.value))
const finalizedHand = computed(() => props.state.pokerTable.finalizedHand ?? null)
const displayBoard = computed(() => visibleHand.value?.board ?? finalizedHand.value?.board ?? [])
const displayPot = computed(() => visibleHand.value?.pot ?? finalizedHand.value?.pots.reduce((sum, pot) => sum + pot.amount, 0) ?? 0)
const tableViewer = computed(() => tablePlayerForViewer(props.state.pokerTable, props.viewerId))
const viewer = computed(() => playerForViewer(hand.value, props.viewerId))
const viewerIsActor = computed(() => isViewerActor(hand.value, props.viewerId))
const canAct = computed(() => viewerIsActor.value && props.connectionStatus === 'connected')
const viewerToCall = computed(() => toCall(hand.value, props.viewerId))
const isPending = computed(() => Boolean(props.pendingActionId))
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
const finalizedWinners = computed(() => finalizedHand.value?.players.filter(player => player.winner) ?? [])
const ownTablePlayer = computed(() => tableViewer.value)

watch(() => [props.state.pokerTable.stateVersion, hand.value?.currentActor, hand.value?.street], () => {
  amount.value = null
})
watch(() => props.stackOperationResultKey, () => {
  if (props.stackOperationResultKey) {
    stackAction.value = null
    stackRequestKey.value = null
  }
})

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

function openStackAction(direction: 'ADD' | 'WITHDRAW') {
  if (!isWaiting.value || props.stackOperationBusy) return
  stackAction.value = direction
  stackAmount.value = null
  stackRequestKey.value = crypto.randomUUID()
}

function submitStackAction() {
  const value = Number(stackAmount.value)
  if (!stackAction.value || !Number.isSafeInteger(value) || value <= 0 || !isWaiting.value || props.stackOperationBusy) return
  if (stackAction.value === 'ADD' && value > (props.walletBalance ?? 0)) return
  if (stackAction.value === 'WITHDRAW' && value >= (ownTablePlayer.value?.stack ?? 0)) return
  if (!stackRequestKey.value) stackRequestKey.value = crypto.randomUUID()
  emit('stackOperation', { direction: stackAction.value, amount: value, requestKey: stackRequestKey.value })
}

function handPlayer(playerId: string): OnlineHandPlayer | null {
  return visibleHand.value?.players.find(item => item.playerId === playerId) ?? null
}

function statusPlayer(playerId: string): OnlineHandPlayer | null {
  return hand.value?.players.find(item => item.playerId === playerId) ?? null
}

function finalizedPlayer(playerId: string): OnlineFinalizedShowdownPlayer | null {
  return finalizedHand.value?.players.find(item => item.playerId === playerId) ?? null
}

function playerCards(playerId: string): readonly OnlineCard[] {
  if (finalizedHand.value) return finalizedPlayer(playerId)?.holeCards ?? []
  if (playerId !== props.viewerId) return []
  return handPlayer(playerId)?.holeCards ?? []
}

function displayName(player: OnlineTablePlayer): string {
  return player.nickname?.trim() || `Игрок ${player.seat}`
}

function cardId(card: { rank: string; suit: string }): string {
  return `${card.rank}:${card.suit}`
}

function isContributingCard(card: { rank: string; suit: string }, playerId?: string): boolean {
  const id = cardId(card)
  if (finalizedHand.value) {
    return isShowdownWinningCard(finalizedHand.value, id, playerId)
  }
  return Boolean(handStrength.value?.contributingCardIds.includes(id))
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

function streetLabel(street: string): string {
  return ({ PREFLOP: 'Префлоп', FLOP: 'Флоп', TURN: 'Терн', RIVER: 'Ривер', SHOWDOWN: 'Вскрытие' } as Record<string, string>)[street] ?? street
}

function cardBacks(playerId: string): boolean {
  return Boolean(visibleHand.value && visibleHand.value.street !== 'SHOWDOWN' && playerId !== props.viewerId && visibleHand.value.players.find(player => player.playerId === playerId)?.status === 'ACTIVE')
}

function finalizedDisplayName(player: OnlineFinalizedShowdownPlayer): string {
  return player.nickname?.trim() || displayName(props.state.pokerTable.players.find(item => item.playerId === player.playerId) ?? { playerId: player.playerId, seat: player.seat, stack: 0, connected: true, ready: false, sittingOut: false })
}
</script>

<template>
  <main class="online-table-page">
    <header class="online-header">
      <div class="room-heading">
        <NuxtLink class="back-link" to="/rooms" aria-label="Назад к столам">← <span>Столы</span></NuxtLink>
        <div class="room-heading__title"><span class="eyebrow">ONLINE · {{ state.visibility === 'PRIVATE' ? 'ПРИВАТНЫЙ' : 'ПУБЛИЧНЫЙ' }}</span><h1>Стол <span>{{ state.roomCode }}</span></h1></div>
        <div class="room-stats" aria-label="Информация о комнате">
          <span><b>{{ state.pokerTable.players.length }}</b>/{{ state.maxPlayers }} игроков</span>
          <span v-if="state.visibility === 'PUBLIC'"><b>{{ spectatorCount ?? 0 }}</b> зрителей</span>
          <span>Блайнды {{ state.pokerTable.smallBlind }} / {{ state.pokerTable.bigBlind }}</span>
        </div>
      </div>
      <div class="header-actions">
        <span class="connection" :class="`connection--${connectionStatus}`" role="status"><i aria-hidden="true"></i>{{ spectating ? 'Наблюдение' : connectionLabel(connectionStatus) }}</span>
        <OnlineFriendInviteModal v-if="!spectating" :room-code="state.roomCode" />
        <button v-if="spectating && isWaiting && state.pokerTable.players.length < state.maxPlayers" class="btn" type="button" :disabled="joinBusy" @click="emit('join')">{{ joinBusy ? 'Подключаем…' : 'Готов' }}</button>
        <button v-else-if="!spectating" class="leave-button" type="button" aria-label="Выйти из комнаты" @click="emit('leave')">Выйти <span aria-hidden="true">↗</span></button>
      </div>
    </header>

    <p v-if="notice" class="notice" role="status" aria-live="polite"><span aria-hidden="true">!</span>{{ notice }}</p>

    <section class="table-stage" aria-label="Покерный стол">
      <div class="felt">
        <div class="table-rail" aria-hidden="true"></div>
        <div class="table-center">
          <div class="table-info-row">
            <span class="hand-state" :class="{ 'hand-state--live': visibleHand, 'hand-state--finished': finalizedHand }">
              <i aria-hidden="true"></i>{{ visibleHand ? streetLabel(visibleHand.street) : finalizedHand ? 'Финал' : 'Ожидание' }}
            </span>
            <span class="blind-chip">SB <b>{{ state.pokerTable.smallBlind }}</b><i></i> BB <b>{{ state.pokerTable.bigBlind }}</b></span>
          </div>
          <div class="board" aria-label="Общие карты">
            <span v-for="(card, index) in displayBoard" :key="`${card.rank}-${card.suit}-${index}`" class="card" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card) }">{{ cardLabel(card) }}</span>
            <span v-if="!displayBoard.length" class="board-empty">Карты появятся здесь</span>
          </div>
          <div v-if="visibleHand || finalizedHand" class="pot-display"><span>БАНК</span><strong>{{ visibleHand?.pot ?? displayPot }}</strong><small>фишек</small></div>
          <div v-else class="table-hint">Ожидаем начало раздачи</div>
        </div>
        <div class="players" aria-label="Игроки">
          <article
            v-for="(player, index) in displayPlayers"
            :key="player.playerId"
            class="player-seat"
            :class="{
              'player-seat--self': player.playerId === viewerId,
              'player-seat--hero': index === 0,
              'player-seat--top': seatPosition(index, displayPlayers.length).top === '5%',
              'player-seat--showdown': Boolean(finalizedHand),
              'player-seat--actor': visibleHand?.currentActor === player.seat,
              'player-seat--offline': !player.connected,
              'player-seat--folded': statusPlayer(player.playerId)?.status === 'FOLDED',
              'player-seat--all-in': statusPlayer(player.playerId)?.status === 'ALL_IN',
              'player-seat--sitting-out': player.sittingOut
            }"
            :style="seatPosition(index, displayPlayers.length)"
          >
            <div class="avatar" aria-hidden="true">{{ displayName(player).slice(0, 1).toUpperCase() }}</div>
            <div class="player-info">
              <strong class="player-name" :title="displayName(player)">{{ displayName(player) }}<span v-if="player.playerId === viewerId" class="you-tag">Вы</span></strong>
              <span class="player-stack">{{ (visibleHand ? handPlayer(player.playerId)?.stack ?? player.stack : player.stack).toLocaleString('ru-RU') }} <small>фишек</small></span>
              <small v-if="visibleHand" class="player-bet">Ставка: {{ handPlayer(player.playerId)?.streetContribution ?? 0 }}</small>
              <small v-if="statusPlayer(player.playerId)?.lastAction" class="player-action">{{ actionLabel(statusPlayer(player.playerId)?.lastAction ?? null) }}</small>
              <small v-if="finalizedPlayer(player.playerId)?.label" class="player-combination">{{ finalizedPlayer(player.playerId)?.label }}</small>
              <small v-if="finalizedPlayer(player.playerId)?.payout" class="player-payout">+{{ finalizedPlayer(player.playerId)?.payout }}</small>
              <small v-if="finalizedPlayer(player.playerId)?.returnedExcess" class="player-returned">Возврат: {{ finalizedPlayer(player.playerId)?.returnedExcess }}</small>
              <small class="player-status"><i aria-hidden="true"></i>{{ statusLabel(player, statusPlayer(player.playerId)) }}</small>
            </div>
            <div class="seat-markers" aria-label="Роли за столом">
              <span v-if="(visibleHand ?? hand)?.dealerSeat === player.seat" class="seat-marker" title="Кнопка дилера">D</span>
              <span v-if="(visibleHand ?? hand)?.smallBlindSeat === player.seat" class="seat-marker seat-marker--blind" title="Малый блайнд">SB</span>
              <span v-if="(visibleHand ?? hand)?.bigBlindSeat === player.seat" class="seat-marker seat-marker--blind" title="Большой блайнд">BB</span>
            </div>
            <div v-if="playerCards(player.playerId).length" class="mini-cards" aria-label="Открытые карты игрока">
              <span v-for="card in playerCards(player.playerId)" :key="`${card.rank}-${card.suit}`" class="mini-card" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card, player.playerId) }">{{ cardLabel(card) }}</span>
            </div>
            <div v-else-if="cardBacks(player.playerId)" class="mini-cards mini-cards--back" aria-label="Закрытые карты"><span class="mini-card">★</span><span class="mini-card">★</span></div>
          </article>
        </div>
      </div>
    </section>

    <section v-if="ownCards.length" class="own-cards panel" aria-label="Ваши карты">
      <div class="own-cards__heading"><span class="section-kicker">ВАШИ КАРТЫ</span><span v-if="handStrength" class="own-cards__strength">{{ handStrength.label }}</span></div>
      <div class="own-cards__list"><span v-for="card in ownCards" :key="`${card.rank}-${card.suit}`" class="card card--large" :class="{ 'card--red': cardIsRed(card), 'card--gold': isContributingCard(card) }">{{ cardLabel(card) }}</span></div>
    </section>

    <section v-if="finalizedHand" class="showdown-summary panel" aria-live="polite" aria-label="Результат раздачи">
      <div class="showdown-summary__heading"><span class="result-medal" aria-hidden="true">♛</span><div><span class="section-kicker">РАЗДАЧА ЗАВЕРШЕНА</span><strong>{{ finalizedWinners.length > 1 ? 'Победители' : 'Победитель' }}</strong></div></div>
      <div class="showdown-winners">
        <div v-for="winner in finalizedWinners" :key="winner.playerId" class="showdown-winner">
          <span class="showdown-winner__identity"><strong>{{ finalizedDisplayName(winner) }}</strong><small>{{ winner.label || 'Победа без вскрытия' }}</small></span>
          <span class="showdown-winner__stack"><small>Стек</small><b>{{ (tablePlayerForViewer(state.pokerTable, winner.playerId)?.stack ?? 0).toLocaleString('ru-RU') }}</b></span>
          <strong class="showdown-winner__payout">+{{ winner.payout }}</strong>
        </div>
      </div>
      <small v-if="finalizedHand.type === 'UNCONTESTED'">Карты не вскрывались: игроки сбросили карты.</small>
    </section>

    <section class="controls panel">
      <div class="control-row">
        <div>
          <span class="section-kicker">{{ visibleHand ? 'ТЕКУЩЕЕ ДЕЙСТВИЕ' : spectating ? 'РЕЖИМ ПРОСМОТРА' : 'СТОЛ' }}</span>
          <strong v-if="visibleHand?.currentActor !== null && visibleHand?.currentActor !== undefined">{{ actor?.playerId === viewerId ? 'Ваш ход' : `Ходит ${actorTablePlayer ? displayName(actorTablePlayer) : 'игрок'}` }}</strong>
          <strong v-else-if="visibleHand">Раунд завершён</strong>
          <strong v-else-if="finalizedHand">Можно начать новую раздачу</strong>
          <strong v-else>Ожидаем готовых игроков</strong>
        </div>
        <OnlineTurnClock v-if="visibleHand?.turnDeadlineAt" :deadline="visibleHand.turnDeadlineAt" />
      </div>

      <div v-if="spectating" class="waiting-controls">
        <p v-if="visibleHand">Вы наблюдаете за раздачей. Присоединиться можно после её завершения.</p>
        <p v-else-if="state.pokerTable.players.length >= state.maxPlayers">За столом нет свободного места. Вы сможете присоединиться, когда оно появится.</p>
        <p v-else>Можно смотреть раздачу или занять свободное место между раздачами.</p>
        <button v-if="isWaiting && state.pokerTable.players.length < state.maxPlayers" class="btn btn--primary" type="button" :disabled="joinBusy" @click="emit('join')">{{ joinBusy ? 'Подключаем…' : 'Занять место' }}</button>
      </div>
      <div v-else-if="isWaiting && tableViewer" class="waiting-controls">
        <button v-if="canStart" class="btn btn--primary" type="button" @click="emit('start')">Начать раздачу</button>
        <button class="btn" :class="ready ? 'btn--ready' : 'btn--primary'" type="button" @click="emit('ready', !ready)">{{ ready ? '✓ Вы готовы' : 'Я готов' }}</button>
        <button class="btn btn--ghost" type="button" @click="emit('sittingOut', !sittingOut)">{{ sittingOut ? 'Вернуться в игру' : 'Сесть вне игры' }}</button>
        <p v-if="!canStart">Ожидаем готовых игроков и владельца стола.</p>
        <div class="stack-control-row" aria-label="Управление стеком">
          <span>Ваш стек <b>{{ (ownTablePlayer?.stack ?? 0).toLocaleString('ru-RU') }}</b></span>
          <button class="btn btn--ghost" type="button" :disabled="!isWaiting || stackOperationBusy" @click="openStackAction('ADD')">＋ Купить фишки</button>
          <button class="btn btn--ghost" type="button" :disabled="!isWaiting || stackOperationBusy || (ownTablePlayer?.stack ?? 0) <= 1" @click="openStackAction('WITHDRAW')">Вывести</button>
        </div>
      </div>

      <div v-else-if="canAct" class="action-grid" aria-label="Действия игрока">
        <button v-if="viewerToCall === 0" class="btn action-button action-button--check" type="button" :disabled="isPending" @click="send('check')"><span>✓</span><b>Чек</b></button>
        <button v-else class="btn action-button action-button--call" type="button" :disabled="isPending" @click="send('call')"><span>↗</span><b>Колл</b><small>{{ callAmount }}</small></button>
        <label v-if="visibleHand?.currentBet === 0 || visibleHand?.currentBet" class="amount-control">
          <span>Целевая ставка</span>
          <div><input v-model.number="amount" class="input" type="number" min="1" :max="maxTargetAmount || 1" inputmode="numeric" placeholder="Сумма"><small>до {{ maxTargetAmount.toLocaleString('ru-RU') }}</small></div>
        </label>
        <button class="btn action-button action-button--raise" type="button" :disabled="isPending || amount === null" @click="send(visibleHand?.currentBet ? 'raise' : 'bet')"><span>＋</span><b>{{ visibleHand?.currentBet ? 'Рейз' : 'Бет' }}</b></button>
        <button class="btn action-button action-button--fold" type="button" :disabled="isPending" @click="send('fold')"><span>×</span><b>Фолд</b></button>
        <button class="btn action-button action-button--allin" type="button" :disabled="isPending" @click="send('all-in')"><span>↗</span><b>Ва-банк</b><small>{{ (viewer?.stack || 0).toLocaleString('ru-RU') }}</small></button>
      </div>
      <p v-else-if="viewerIsActor && connectionStatus !== 'connected'" class="waiting">{{ connectionLabel(connectionStatus) }}. Действия временно недоступны.</p>
      <p v-else-if="visibleHand" class="waiting">Ожидаем ход другого игрока.</p>
      <p v-else-if="!spectating && !tableViewer" class="waiting">Подключите игрока к столу, чтобы начать.</p>
      <p v-else-if="!isWaiting && !finalizedHand" class="waiting">{{ connectionLabel(connectionStatus) }}</p>
      <div v-if="visibleHand && tableViewer && !spectating" class="stack-control-row stack-control-row--locked" aria-label="Управление стеком недоступно во время раздачи">
        <span>Ваш стек <b>{{ (ownTablePlayer?.stack ?? 0).toLocaleString('ru-RU') }}</b><small>Управление доступно между раздачами</small></span>
        <button class="btn btn--ghost" type="button" disabled title="Доступно между раздачами">＋ Купить фишки</button>
        <button class="btn btn--ghost" type="button" disabled title="Доступно между раздачами">Вывести</button>
      </div>
    </section>

    <aside v-if="connectionStatus === 'reconnecting' || connectionStatus === 'error' || connectionStatus === 'unavailable'" class="reconnect-banner" role="status">
      <span><b>Соединение потеряно</b><small>Пробуем восстановить связь со столом</small></span>
      <button class="btn btn--ghost reconnect-button" type="button" @click="emit('reconnect')">Переподключить</button>
    </aside>

    <div v-if="stackAction" class="stack-modal-backdrop" @click.self="stackOperationBusy ? undefined : stackAction = null">
      <section class="stack-modal panel" role="dialog" aria-modal="true" :aria-label="stackAction === 'ADD' ? 'Добавить в стек' : 'Вывести из стека'">
        <span class="section-kicker">УПРАВЛЕНИЕ СТЕКОМ</span>
        <h2>{{ stackAction === 'ADD' ? 'Добавить в стек' : 'Вывести из стека' }}</h2>
        <p>Текущий стек: <strong>{{ (ownTablePlayer?.stack ?? 0).toLocaleString('ru-RU') }}</strong></p>
        <p>Доступно на балансе: <strong>{{ (walletBalance ?? 0).toLocaleString('ru-RU') }}</strong></p>
        <label class="stack-modal__amount">Сумма
          <input v-model.number="stackAmount" class="input" type="number" min="1" :max="stackAction === 'ADD' ? walletBalance : Math.max(0, (ownTablePlayer?.stack ?? 0) - 1)" inputmode="numeric" placeholder="Введите сумму">
        </label>
        <p v-if="stackAction === 'WITHDRAW' && stackAmount === ownTablePlayer?.stack" class="stack-modal__hint">Чтобы вывести весь стек, выйдите из комнаты.</p>
        <div class="stack-modal__buttons">
          <button class="btn btn--ghost" type="button" :disabled="stackOperationBusy" @click="stackAction = null">Отмена</button>
          <button class="btn" type="button" :disabled="stackOperationBusy || !Number.isSafeInteger(Number(stackAmount)) || Number(stackAmount) <= 0 || (stackAction === 'ADD' && Number(stackAmount) > (walletBalance ?? 0)) || (stackAction === 'WITHDRAW' && Number(stackAmount) >= (ownTablePlayer?.stack ?? 0))" @click="submitStackAction">{{ stackOperationBusy ? 'Обработка…' : 'Подтвердить' }}</button>
        </div>
      </section>
    </div>
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
.stack-actions { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .35rem; }
.stack-actions .btn { min-height: 30px; padding: .25rem .45rem; font-size: .68rem; }
.stack-modal-backdrop { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.68); }
.stack-modal { width: min(100%, 390px); display: grid; gap: .65rem; padding: 1rem; }
.stack-modal h2, .stack-modal p { margin: 0; }
.stack-modal__amount { display: grid; gap: .35rem; color: var(--text-muted); }
.stack-modal__hint { color: var(--danger); font-size: .8rem; }
.stack-modal__buttons { display: flex; justify-content: flex-end; gap: .5rem; }
.table-wrap { min-height: 360px; }
.felt { position: relative; isolation: isolate; min-height: 390px; overflow: hidden; border: 9px solid #70461e; border-radius: 48%; background: radial-gradient(ellipse at center, #1a744b 0%, #0c442d 60%, #092b20 100%); box-shadow: inset 0 0 0 3px rgba(255,255,255,.08), 0 18px 35px rgba(0,0,0,.28); }
.table-meta { position: absolute; z-index: 1; top: 40%; left: 50%; transform: translate(-50%, -50%); display: flex; gap: .55rem; align-items: center; max-width: calc(100% - 1.5rem); padding: .24rem .55rem; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: rgba(7,35,24,.72); color: rgba(255,255,255,.8); font-size: .72rem; line-height: 1.2; white-space: nowrap; text-transform: uppercase; letter-spacing: .08em; }
.table-meta strong { color: var(--accent-strong); letter-spacing: 0; text-transform: none; font-size: .9rem; }
.board { position: absolute; z-index: 1; top: 57%; left: 50%; display: flex; justify-content: center; gap: .3rem; min-height: 52px; transform: translate(-50%, -50%); }
.card, .mini-card { display: grid; place-items: center; color: #15221b; background: #f7f4ea; border-radius: .38rem; font-weight: 700; box-shadow: 0 3px 8px rgba(0,0,0,.25); }
.card { width: 38px; height: 52px; font-size: .85rem; }
.card--large { width: 58px; height: 80px; font-size: 1.2rem; }
.card--red { color: #bd3d38; }
.card--gold { border-color: #f2b451; box-shadow: 0 0 0 2px rgba(242,180,81,.82), 0 0 15px rgba(242,180,81,.52); }
.board-empty { color: rgba(255,255,255,.54); font-size: .72rem; white-space: nowrap; align-self: center; }
.players { position: absolute; z-index: 4; inset: 0; pointer-events: none; }
.player-seat { position: absolute; z-index: 5; width: 112px; min-width: 0; padding: .35rem; border: 1px solid rgba(255,255,255,.18); border-radius: .65rem; transform: translate(-50%, -50%); background: rgba(9,27,20,.94); font-size: .68rem; transition: border-color .15s, box-shadow .15s; pointer-events: auto; }
.player-seat--top { transform: translate(-50%, 0); }
.player-seat--self { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(242,180,81,.22); }
.player-seat--actor { border-color: var(--accent-strong); box-shadow: 0 0 0 2px rgba(242,180,81,.3); }
.player-seat--offline, .player-seat--folded, .player-seat--sitting-out { opacity: .55; }
.player-seat--all-in { border-color: #d97f54; }
.avatar { float: left; display: grid; place-items: center; width: 25px; height: 25px; margin-right: .28rem; border-radius: 50%; color: #172116; background: var(--accent); font-weight: 700; }
.player-info { min-width: 0; display: grid; gap: .05rem; }
.player-info strong, .player-info span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.player-info span { color: var(--text-muted); }
.player-info small { overflow: hidden; color: var(--text-muted); text-overflow: ellipsis; white-space: nowrap; }
.player-info .player-bet { color: var(--accent-strong); font-weight: 700; }
.player-info .player-action { color: #f5d88c; font-weight: 700; }
.player-info .player-combination { color: #f2b451; font-weight: 700; }
.player-info .player-payout { color: #9fe3a8; font-weight: 700; }
.player-info .player-returned { color: #b8d8ca; }
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
.showdown-summary { display: grid; gap: .45rem; border: 1px solid rgba(242,180,81,.42); background: rgba(242,180,81,.09); }
.showdown-summary > strong { color: var(--accent-strong); font-size: 1.05rem; }
.showdown-winners { display: grid; gap: .3rem; }
.showdown-winner { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .55rem; align-items: center; }
.showdown-winner strong { color: #9fe3a8; }
.showdown-summary small { color: var(--text-muted); }
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
@media (min-width: 700px) { .online-table-page { padding: 1.2rem 1rem 2rem; } .felt { min-height: 520px; } .table-meta { top: 35%; } .board { top: 52%; } .player-seat { width: 145px; padding: .5rem; font-size: .78rem; } .card { width: 48px; height: 68px; font-size: 1rem; } .card--large { width: 70px; height: 96px; } .action-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .amount-control { grid-column: span 2; } }
@media (max-width: 400px) { .felt { min-height: 345px; border-width: 6px; } .table-meta { top: 44%; } .board { top: 58%; } .player-seat { width: 94px; font-size: .6rem; } .avatar { width: 21px; height: 21px; } .card { width: 31px; height: 44px; font-size: .72rem; } .board { gap: .18rem; } .seat-marker { min-width: 18px; font-size: .5rem; } }

/* ONLINE table experience */
.online-table-page { box-sizing: border-box; width: min(100%, 1160px); max-width: none; gap: 1rem; padding: max(.8rem, env(safe-area-inset-top, 0px)) max(1rem, env(safe-area-inset-left, 0px)) calc(1.25rem + env(safe-area-inset-bottom, 0px)) max(1rem, env(safe-area-inset-right, 0px)); color: var(--text-primary, #edf5ee); }
.online-header { align-items: center; gap: 1.2rem; padding: .15rem .2rem .35rem; }
.room-heading { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: .8rem; row-gap: .35rem; min-width: 0; }
.back-link { grid-row: 1 / 3; display: inline-flex; align-items: center; justify-content: center; gap: .35rem; min-width: 42px; min-height: 42px; border: 1px solid rgba(255,255,255,.1); border-radius: 14px; color: var(--text-muted); background: rgba(255,255,255,.035); text-decoration: none; }
.room-heading__title { min-width: 0; }
.eyebrow { color: #83aa94; font-size: .62rem; font-weight: 800; letter-spacing: .15em; }
.online-header h1 { margin: .06rem 0 0; font-size: clamp(1.25rem, 3.5vw, 1.8rem); letter-spacing: -.035em; }
.online-header h1 span { color: #f2d28e; }
.room-stats { grid-column: 2; display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; min-width: 0; }
.room-stats span { padding: .28rem .48rem; border: 1px solid rgba(255,255,255,.075); border-radius: 999px; color: var(--text-muted); background: rgba(255,255,255,.035); font-size: .65rem; white-space: nowrap; }
.room-stats b { color: #e4c782; }
.header-actions { display: flex; align-items: center; justify-content: flex-end; gap: .45rem; flex-wrap: wrap; }
.connection { display: inline-flex; align-items: center; gap: .35rem; min-height: 34px; padding: .3rem .55rem; border: 1px solid rgba(138,208,162,.16); border-radius: 999px; background: rgba(138,208,162,.055); font-size: .68rem; }
.connection i, .player-status i, .hand-state i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #86d2a2; box-shadow: 0 0 9px currentColor; }
.connection--reconnecting, .connection--connecting, .connection--loading { color: #e9ca7f; border-color: rgba(233,202,127,.2); background: rgba(233,202,127,.07); }
.connection--reconnecting i, .connection--connecting i, .connection--loading i { background: #e9ca7f; }
.connection--error, .connection--unauthorized, .connection--not-found, .connection--unavailable, .connection--disconnected { color: #ffaaa1; border-color: rgba(255,120,110,.22); background: rgba(255,120,110,.07); }
.connection--error i, .connection--unauthorized i, .connection--not-found i, .connection--unavailable i, .connection--disconnected i { background: #ff8e83; }
.leave-button { min-height: 40px; padding: .45rem .65rem; border: 1px solid rgba(255,255,255,.09); border-radius: 12px; color: var(--text-muted); background: rgba(255,255,255,.035); font: inherit; font-size: .72rem; cursor: pointer; }
.leave-button span { margin-left: .22rem; opacity: .7; }
.notice { display: flex; align-items: center; gap: .55rem; padding: .7rem .85rem; border: 1px solid rgba(242,180,81,.24); line-height: 1.4; }
.notice > span { flex: 0 0 auto; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; color: #1b261d; background: #f2b451; font-weight: 900; }
.table-stage { min-width: 0; }
.felt { box-sizing: border-box; min-height: 0; height: clamp(450px, 52vw, 590px); overflow: hidden; border: 10px solid #684425; border-radius: 50% / 42%; background: radial-gradient(ellipse at 50% 45%, #23734e 0%, #13573a 49%, #0a3929 100%); box-shadow: inset 0 0 0 2px rgba(238,207,135,.24), inset 0 0 42px rgba(0,0,0,.23), 0 20px 45px rgba(0,0,0,.3); }
.table-rail { position: absolute; inset: 7px; z-index: 0; border: 1px solid rgba(238,207,135,.19); border-radius: inherit; pointer-events: none; }
.hand-state, .blind-chip { display: inline-flex; align-items: center; gap: .35rem; min-height: 29px; padding: .28rem .55rem; border: 1px solid rgba(255,255,255,.11); border-radius: 999px; color: #d4e7d8; background: rgba(4,25,18,.67); font-size: .62rem; font-weight: 700; white-space: nowrap; backdrop-filter: blur(8px); }
.hand-state i { width: 6px; height: 6px; background: #b9c7bb; box-shadow: none; }
.hand-state--live i { background: #7de7a2; box-shadow: 0 0 10px #7de7a2; }
.hand-state--finished { color: #f5d68d; }
.blind-chip { color: #b8cec0; font-variant-numeric: tabular-nums; }
.blind-chip b { color: #f2d28e; }
.blind-chip i { height: 12px; border-left: 1px solid rgba(255,255,255,.2); }
.table-center { position: absolute; z-index: 2; top: 48%; left: 50%; display: grid; justify-items: center; gap: .55rem; width: min(72%, 480px); transform: translate(-50%, -50%); }
.table-info-row { display: flex; align-items: center; justify-content: center; gap: .35rem; max-width: 100%; }
.board { position: static; display: flex; justify-content: center; align-items: center; gap: clamp(.18rem, .55vw, .55rem); min-height: 0; transform: none; }
.card { width: clamp(35px, 4.3vw, 55px); height: clamp(49px, 6vw, 76px); border: 1px solid rgba(10,30,19,.12); border-radius: 9px; font-size: clamp(.78rem, 1.2vw, 1.05rem); }
.board-empty { text-align: center; font-size: .68rem; }
.pot-display { display: flex; align-items: baseline; justify-content: center; gap: .4rem; padding: .28rem .72rem; border: 1px solid rgba(242,210,142,.2); border-radius: 999px; color: #dce9dd; background: rgba(4,25,18,.63); font-size: .6rem; backdrop-filter: blur(8px); }
.pot-display span { color: #a1b5a5; letter-spacing: .14em; }
.pot-display strong { color: #f1d38f; font-size: .9rem; font-variant-numeric: tabular-nums; }
.pot-display small { color: #8fa597; }
.table-hint { color: rgba(222,239,226,.62); font-size: .65rem; }
.players { z-index: 4; }
.player-seat { box-sizing: border-box; width: clamp(98px, 14vw, 154px); min-height: 72px; padding: .42rem .48rem; border: 1px solid rgba(221,239,223,.17); border-radius: 15px; background: linear-gradient(145deg, rgba(14,39,29,.97), rgba(7,25,19,.97)); box-shadow: 0 7px 18px rgba(0,0,0,.3); font-size: .72rem; backdrop-filter: blur(8px); }
.player-seat--hero { transform: translate(-50%, -100%); }
.player-seat--top { transform: translate(-50%, 0); }
.player-seat--self { border-color: rgba(242,180,81,.7); box-shadow: 0 0 0 2px rgba(242,180,81,.16), 0 8px 20px rgba(0,0,0,.28); }
.player-seat--actor { border-color: #83e2a4; box-shadow: 0 0 0 2px rgba(131,226,164,.27), 0 0 22px rgba(131,226,164,.15); }
.player-seat--offline, .player-seat--folded, .player-seat--sitting-out { opacity: .62; filter: saturate(.62); }
.player-seat--all-in { border-color: #ed9a6e; }
.player-seat--showdown .avatar { position: absolute; top: .4rem; left: .4rem; }
.player-seat--showdown .player-info { padding-top: 0; padding-left: 31px; }
.player-seat--showdown .player-bet, .player-seat--showdown .player-action, .player-seat--showdown .player-status { display: none; }
.player-seat--showdown .player-info .player-name { font-size: .68rem; }
.player-seat--showdown .player-info .player-stack { font-size: .66rem; }
.player-seat--showdown .player-info small { font-size: .53rem; }
.player-seat--showdown .mini-card { width: 19px; height: 25px; }
.avatar { float: none; width: 27px; height: 27px; margin: 0; border: 1px solid rgba(242,180,81,.4); color: #f7dfa1; background: linear-gradient(145deg,#72552d,#40331f); font-size: .72rem; }
.player-info { gap: .11rem; padding-top: .13rem; }
.player-info .player-name { display: flex; align-items: center; gap: .25rem; min-width: 0; color: #f0f4ed; font-size: .74rem; }
.you-tag { flex: 0 0 auto; padding: .06rem .22rem; border-radius: 5px; color: #18231b; background: #e3c67e; font-size: .5rem; }
.player-info .player-stack { color: #f1d38e; font-size: .78rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.player-info .player-stack small { color: #a0b4a5; font-size: .56rem; font-weight: 500; }
.player-info small { font-size: .59rem; }
.player-info .player-status { display: flex; align-items: center; gap: .27rem; color: #a4b8a9; font-size: .55rem; }
.player-status i { width: 5px; height: 5px; box-shadow: none; }
.player-seat--offline .player-status i { background: #ff9b91; }
.player-seat--folded .player-status i, .player-seat--sitting-out .player-status i { background: #a9ada8; }
.player-seat--all-in .player-status i { background: #ee9b6e; }
.seat-markers { top: -.42rem; right: -.32rem; }
.seat-marker { min-width: 19px; height: 19px; border: 1px solid rgba(8,28,19,.55); font-size: .52rem; }
.mini-cards { position: absolute; right: .3rem; bottom: .35rem; margin: 0; gap: .12rem; }
.mini-card { width: 22px; height: 29px; border-radius: 5px; font-size: .5rem; }
.player-seat:has(.mini-cards) { padding-bottom: 2.1rem; }
.player-seat:has(.mini-cards) .mini-cards { right: .38rem; bottom: .4rem; }
.own-cards { display: grid; justify-items: center; gap: .45rem; padding: .75rem; border: 1px solid rgba(238,207,135,.18); border-radius: 18px; background: linear-gradient(105deg, rgba(28,57,41,.9), rgba(13,32,24,.94)); }
.own-cards__heading { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: .5rem; }
.own-cards__strength { padding: .2rem .45rem; border-radius: 999px; color: #f0d28d; background: rgba(242,180,81,.1); font-size: .68rem; font-weight: 700; }
.own-cards__list { gap: .55rem; }
.card--large { width: 56px; height: 76px; border-radius: 10px; }
.showdown-summary { display: grid; gap: .65rem; padding: .9rem; border: 1px solid rgba(242,180,81,.33); border-radius: 18px; background: linear-gradient(115deg, rgba(74,57,28,.35), rgba(13,32,24,.94)); }
.showdown-summary__heading { display: flex; align-items: center; gap: .6rem; }
.showdown-summary__heading > div { display: grid; gap: .12rem; }
.showdown-summary__heading > div > strong { color: #f3d68e; font-size: 1rem; }
.result-medal { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid rgba(242,180,81,.32); border-radius: 13px; color: #f2d28e; background: rgba(242,180,81,.1); font-size: 1.3rem; }
.showdown-winners { gap: .45rem; }
.showdown-winner { grid-template-columns: minmax(0,1fr) auto auto; gap: .75rem; padding: .65rem .7rem; border: 1px solid rgba(255,255,255,.08); border-radius: 13px; background: rgba(0,0,0,.13); }
.showdown-winner__identity { display: grid; gap: .18rem; min-width: 0; }
.showdown-winner__identity strong { overflow: hidden; color: #f2f4ed; text-overflow: ellipsis; white-space: nowrap; }
.showdown-winner__identity small, .showdown-winner__stack small { color: #a7b7a9; font-size: .65rem; }
.showdown-winner__stack { display: grid; text-align: right; }
.showdown-winner__stack b { color: #e5eee4; font-variant-numeric: tabular-nums; }
.showdown-winner__payout { align-self: center; color: #a8e2b4; font-size: .94rem; font-variant-numeric: tabular-nums; }
.controls { display: grid; gap: .8rem; padding: .9rem; border: 1px solid rgba(255,255,255,.09); border-radius: 19px; background: linear-gradient(145deg, rgba(21,46,34,.96), rgba(11,29,22,.98)); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.control-row { align-items: center; padding-bottom: .55rem; border-bottom: 1px solid rgba(255,255,255,.075); }
.control-row > div:first-child { display: grid; gap: .15rem; }
.control-row strong { font-size: 1rem; }
.section-kicker { font-size: .59rem; font-weight: 800; }
.waiting-controls { gap: .5rem; }
.waiting-controls p { line-height: 1.45; }
.waiting-controls .btn { min-height: 48px; }
.waiting-controls .btn--primary, .btn--primary { border-color: transparent; color: #17251d; background: linear-gradient(110deg,#f2d393,#cfa65e); font-weight: 800; }
.btn--ready { border: 1px solid rgba(135,218,162,.4); color: #b7ecc7; background: rgba(83,166,111,.16); }
.stack-control-row { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin-top: .25rem; padding-top: .65rem; border-top: 1px solid rgba(255,255,255,.075); }
.stack-control-row > span { margin-right: auto; color: #a9bcae; font-size: .72rem; }
.stack-control-row > span b { margin-left: .25rem; color: #f0d28e; font-size: .85rem; }
.stack-control-row > span small { display: block; margin-top: .1rem; color: #8ea394; font-size: .62rem; }
.stack-control-row .btn { min-height: 44px; padding: .4rem .65rem; font-size: .7rem; }
.stack-control-row--locked { margin-top: .4rem; padding-top: .6rem; }
.action-grid { align-items: stretch; gap: .5rem; grid-template-columns: repeat(2, minmax(0,1fr)); }
.action-button { display: grid; grid-template-columns: auto minmax(0,1fr); align-content: center; justify-items: center; column-gap: .42rem; min-height: 54px; padding: .5rem .65rem; border: 1px solid transparent; border-radius: 14px; line-height: 1.1; }
.action-button > span { grid-row: span 2; align-self: center; font-size: 1.08rem; }
.action-button b { font-size: .88rem; }
.action-button small { color: inherit; opacity: .76; font-size: .65rem; font-variant-numeric: tabular-nums; }
.action-button--check, .action-button--call { color: #d2f1dc; border-color: rgba(116,213,151,.22); background: linear-gradient(135deg,#285d41,#19442f); }
.action-button--raise { color: #1d281d; background: linear-gradient(135deg,#efcf83,#c79d4f); font-weight: 800; }
.action-button--fold { color: #e3c6c3; border-color: rgba(231,133,123,.18); background: rgba(106,49,48,.48); }
.action-button--allin { grid-column: 1 / -1; min-height: 52px; color: #fff0e7; border-color: rgba(233,133,104,.29); background: linear-gradient(110deg,#713d32,#4e2e2b); }
.amount-control { grid-column: 1 / -1; display: grid; gap: .3rem; color: #afc0b3; font-size: .68rem; }
.amount-control > div { display: flex; align-items: center; gap: .5rem; min-width: 0; }
.amount-control input { flex: 1; min-width: 0; min-height: 48px; box-sizing: border-box; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; color: #f3f5ef; background: rgba(3,20,14,.66); font-size: 1rem; }
.amount-control small { flex: 0 0 auto; color: #91a799; font-size: .66rem; }
.waiting { margin: 0; padding: .4rem 0; color: #a8baac; font-size: .78rem; line-height: 1.45; }
.reconnect-banner { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .65rem .75rem; border: 1px solid rgba(233,202,127,.2); border-radius: 15px; background: rgba(76,62,31,.2); }
.reconnect-banner > span { display: grid; gap: .1rem; }
.reconnect-banner b { color: #f1d38e; font-size: .78rem; }
.reconnect-banner small { color: #aeb9a9; font-size: .68rem; }
.reconnect-button { min-height: 42px; white-space: nowrap; }
.stack-modal-backdrop { overflow-y: auto; padding: max(.75rem,env(safe-area-inset-top,0px)) max(.75rem,env(safe-area-inset-right,0px)) max(.75rem,env(safe-area-inset-bottom,0px)) max(.75rem,env(safe-area-inset-left,0px)); }
.stack-modal { box-sizing: border-box; max-height: calc(100dvh - 1.5rem - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px)); overflow-y: auto; border: 1px solid rgba(242,180,81,.24); border-radius: 20px; background: linear-gradient(145deg,#17372a,#0e241b); }
.stack-modal__buttons .btn { min-height: 46px; }
.player-seat:focus-within, .btn:focus-visible, .leave-button:focus-visible, .back-link:focus-visible { outline: 2px solid #f2d28e; outline-offset: 2px; }
.btn:disabled { opacity: .48; filter: saturate(.55); cursor: not-allowed; }
@media (min-width: 700px) {
  .online-table-page { gap: 1.15rem; padding: max(1.2rem,env(safe-area-inset-top,0px)) 1.4rem calc(2rem + env(safe-area-inset-bottom,0px)); }
  .felt { height: clamp(500px,42vw,590px); }
  .table-center { top: 48%; }
  .controls { padding: 1rem 1.1rem; }
  .action-grid { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .amount-control { grid-column: span 2; }
  .action-button--allin { grid-column: auto; }
}
@media (max-width: 699px) {
  .online-header { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: .35rem .45rem; }
  .room-heading { grid-column: 1; grid-row: 1; grid-template-columns: 36px minmax(0,1fr); gap: .2rem .45rem; }
  .back-link { min-width: 36px; min-height: 36px; grid-row: 1; font-size: 1rem; }
  .back-link span { display: none; }
  .room-heading__title { grid-column: 2; grid-row: 1; }
  .room-heading__title .eyebrow { font-size: .53rem; }
  .online-header h1 { font-size: 1.18rem; }
  .room-stats { grid-column: 2; grid-row: 2; gap: .2rem; }
  .room-stats span { padding: .2rem .35rem; font-size: .55rem; }
  .room-stats span:last-child { display: none; }
  .header-actions { grid-column: 2; grid-row: 1 / 3; display: grid; justify-items: end; gap: .25rem; }
  .connection { min-height: 27px; padding: .2rem .4rem; font-size: .57rem; }
  .leave-button { min-height: 34px; padding: .35rem .5rem; font-size: .65rem; }
  .felt { height: 360px; border-width: 7px; border-radius: 50% / 39%; }
  .hand-state, .blind-chip { min-height: 26px; padding: .22rem .4rem; gap: .25rem; font-size: .54rem; }
  .table-center { top: 46%; width: 78%; gap: .4rem; }
  .card { width: clamp(30px,8vw,36px); height: clamp(44px,11vw,50px); border-radius: 7px; font-size: .72rem; }
  .player-seat { width: clamp(88px,24vw,108px); min-height: 66px; padding: .33rem .38rem; border-radius: 12px; font-size: .65rem; }
  .player-seat--hero { top: 98% !important; }
  .player-info .player-name { font-size: .68rem; }
  .player-info .player-stack { font-size: .7rem; }
  .player-info small { font-size: .54rem; }
  .player-info .player-status { font-size: .5rem; }
  .avatar { width: 23px; height: 23px; }
  .mini-card { width: 20px; height: 26px; font-size: .46rem; }
  .own-cards { padding: .62rem; }
  .controls { padding: .8rem; }
  .waiting-controls { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .waiting-controls > .btn--primary:first-of-type { grid-column: 1 / -1; }
  .waiting-controls p { grid-column: 1 / -1; }
  .stack-control-row { gap: .3rem; }
  .stack-control-row > span { flex-basis: 100%; }
  .stack-control-row .btn { flex: 1; }
  .showdown-winner { gap: .45rem; padding: .55rem; }
}
@media (max-width: 390px) {
  .online-table-page { padding-inline: max(.65rem,env(safe-area-inset-left,0px)) max(.65rem,env(safe-area-inset-right,0px)); gap: .75rem; }
  .room-stats span { font-size: .51rem; }
  .connection { max-width: 110px; font-size: .53rem; }
  .header-actions :deep(.online-friend-invite-trigger) { min-width: 42px; width: 42px; min-height: 42px; padding: .25rem; overflow: hidden; font-size: 0; }
  .header-actions :deep(.online-friend-invite-trigger)::before { content: '＋'; font-size: 1.35rem; line-height: 1; }
  .felt { height: 350px; border-width: 6px; }
  .player-seat { width: 92px; min-height: 62px; padding: .28rem .32rem; }
  .player-info .player-name { font-size: .62rem; }
  .player-info .player-stack { font-size: .65rem; }
  .player-info .player-stack small { font-size: .49rem; }
  .player-info small { font-size: .49rem; }
  .player-info .player-status { font-size: .47rem; }
  .seat-marker { min-width: 17px; height: 17px; }
  .mini-card { width: 18px; height: 24px; }
  .showdown-winner { grid-template-columns: minmax(0,1fr) auto auto; }
  .showdown-winner__stack { display: grid; }
  .showdown-winner__payout { grid-column: auto; grid-row: auto; }
  .action-button { min-height: 52px; }
}
@media (max-width: 360px) {
  .felt { height: 342px; }
  .player-seat { width: 88px; }
  .board .card { width: 28px; }
  .hand-state, .blind-chip { padding-inline: .3rem; font-size: .5rem; }
}
@media (orientation: landscape) and (max-height: 520px) {
  .online-table-page { width: min(100%,1280px); grid-template-columns: minmax(0,1.65fr) minmax(250px,.75fr); align-items: start; gap: .65rem; }
  .online-header, .notice, .table-stage, .own-cards, .showdown-summary, .reconnect-banner { grid-column: 1 / -1; }
  .online-header { grid-row: 1; }
  .table-stage { grid-row: 2; }
  .felt { height: 390px; }
  .controls { grid-column: 2; grid-row: 3 / span 2; }
  .own-cards { grid-column: 1; }
  .showdown-summary { grid-column: 1 / -1; }
  .stack-modal-backdrop { grid-column: 1 / -1; }
}
</style>
