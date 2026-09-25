<script setup lang="ts">
import OnlinePokerTable from '~/components/online/OnlinePokerTable.vue'
import { useAccountStore } from '~/stores/account'
import { useOnlineRoomSocket } from '~/composables/useOnlineRoomSocket'
import { ensureYandexSession, yandexAuthHeaders } from '~/platform/yandexSession'
import { platformFromPath } from '~/platform/types'
import type { OnlineApiResult, OnlineRoomState } from '~/types/online'

const route = useRoute()
const account = useAccountStore()
const isYandex = computed(() => platformFromPath(route.path, route.query.platform) === 'YANDEX_GAMES')
const code = computed(() => String(route.params.code || '').trim().toUpperCase())
const state = ref<OnlineRoomState | null>(null)
const concurrencyToken = ref<string | null>(null)
const loading = ref(true)
const errorStatus = ref<'not-found' | 'unauthorized' | 'unavailable' | 'error' | null>(null)
const notice = ref('')
const ready = ref(false)
const sittingOut = ref(false)
const joinPrompt = ref(false)
const privateRoom = ref(false)
const joinSecret = ref('')
const joinBusy = ref(false)
const spectatorCount = ref(0)
const walletBalance = ref(0)
const stackOperationBusy = ref(false)
const stackOperationResultKey = ref(0)
let spectatorPoll: ReturnType<typeof setInterval> | undefined

function applyAuthoritativeState(next: OnlineRoomState, token?: string): boolean {
  if (state.value && (next.roomVersion < state.value.roomVersion || (next.roomVersion === state.value.roomVersion && next.pokerTable.stateVersion < state.value.pokerTable.stateVersion))) return false
  state.value = next
  if (token) concurrencyToken.value = token
  const player = next.pokerTable.players.find(candidate => candidate.playerId === account.user?.id)
  privateRoom.value = next.visibility === 'PRIVATE'
  joinPrompt.value = !player && (next.visibility === 'PRIVATE' || (route.query.join === '1' && next.pokerTable.status === 'WAITING' && (!next.pokerTable.currentHand || next.pokerTable.currentHand.street === 'FINISHED') && next.pokerTable.players.length < next.maxPlayers))
  ready.value = player?.ready ?? false
  sittingOut.value = player?.sittingOut ?? false
  return true
}

const socket = useOnlineRoomSocket(code, {
  onState(next, token) {
    if (applyAuthoritativeState(next, token)) notice.value = ''
  },
  onNotice(message) { notice.value = message }
})

const canStart = computed(() => Boolean(state.value && state.value.ownerId === account.user?.id && state.value.pokerTable.status === 'WAITING' && state.value.pokerTable.players.filter(player => player.ready && !player.sittingOut && player.connected && player.stack > 0).length >= 2))
const connectionStatus = computed(() => socket.status.value)
const pendingActionId = computed(() => socket.pendingActionId.value)
const socketNotice = computed(() => socket.errorMessage.value)
const viewerIsMember = computed(() => Boolean(state.value?.pokerTable.players.some(player => player.playerId === account.user?.id)))

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
}

function friendlyError(error: unknown): string {
  const status = statusCode(error)
  const message = String((error as { statusMessage?: string; data?: { statusMessage?: string; message?: string } }).statusMessage ?? (error as { data?: { statusMessage?: string; message?: string } }).data?.statusMessage ?? (error as { data?: { message?: string } }).data?.message ?? '')
  if (/во время раздачи/i.test(message)) return 'Нельзя изменить стек во время раздачи.'
  if (/недостаточно фишек на балансе/i.test(message)) return 'Недостаточно фишек на балансе.'
  if (/превышает доступный стек/i.test(message)) return 'Сумма больше текущего стека.'
  if (/весь стек/i.test(message)) return 'Чтобы вывести весь стек, выйдите из комнаты.'
  if (/операци.*выполняется|завершается изменение стека/i.test(message)) return 'Операция уже выполняется. Обновляем стол…'
  if (status === 409 && /недостаточно|insufficient/i.test(message)) return 'Недостаточно фишек для входа за стол.'
  if (status === 409) return 'Место уже занято или стол изменился. Вы остались зрителем — обновите стол и попробуйте снова.'
  if (status === 401 || status === 403) return 'Войдите в аккаунт, чтобы открыть этот стол.'
  if (status === 404 || status === 410) return 'Стол не найден или уже закрыт.'
  if (status === 503) return 'Сервис стола временно недоступен. Попробуйте ещё раз.'
  return 'Не удалось загрузить стол. Попробуйте ещё раз.'
}

async function loadState() {
  loading.value = true
  errorStatus.value = null
  joinPrompt.value = false
  try {
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/state`, { headers: yandexAuthHeaders(isYandex.value), retry: 0 })
    applyAuthoritativeState(result.room, result.concurrencyToken)
    const player = result.room.pokerTable.players.find(candidate => candidate.playerId === account.user?.id)
    privateRoom.value = result.room.visibility === 'PRIVATE'
    joinPrompt.value = !player && (result.room.visibility === 'PRIVATE' || (route.query.join === '1' && result.room.pokerTable.status === 'WAITING' && (!result.room.pokerTable.currentHand || result.room.pokerTable.currentHand.street === 'FINISHED') && result.room.pokerTable.players.length < result.room.maxPlayers))
    ready.value = player?.ready ?? false
    sittingOut.value = player?.sittingOut ?? false
    loading.value = false
  } catch (error) {
    loading.value = false
    const status = statusCode(error)
    if (status === 403 && account.user) {
      privateRoom.value = true
      joinPrompt.value = true
      return
    }
    errorStatus.value = status === 401 || status === 403 ? 'unauthorized' : status === 404 || status === 410 ? 'not-found' : status === 503 ? 'unavailable' : 'error'
  }
}

async function loadSpectatorCount() {
  if (state.value?.visibility !== 'PUBLIC' || errorStatus.value) {
    spectatorCount.value = 0
    return
  }
  try {
    const result = await $fetch<{ count: number }>(`/api/online/rooms/${encodeURIComponent(code.value)}/spectators`, { headers: yandexAuthHeaders(isYandex.value), retry: 0 })
    spectatorCount.value = Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : 0
  } catch {
    // The game state remains available if the optional live spectator count is temporarily unavailable.
  }
}

async function joinRoom() {
  if (joinBusy.value || !account.user) {
    if (!account.user) await navigateTo(isYandex.value ? '/yandex' : `/login?redirect=${encodeURIComponent(`/online/${code.value}`)}`)
    return
  }
  joinBusy.value = true
  notice.value = ''
  let seatingSucceeded = false
  try {
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/join`, {
      method: 'POST',
      body: {
        ...(concurrencyToken.value ? { concurrencyToken: concurrencyToken.value } : {}),
        ...(state.value?.roomVersion === undefined ? {} : { expectedRoomVersion: state.value.roomVersion }),
        ...(joinSecret.value ? { joinSecret: joinSecret.value } : {})
      },
      headers: yandexAuthHeaders(isYandex.value),
      retry: 0
    })
    seatingSucceeded = true
    applyAuthoritativeState(result.room, result.concurrencyToken)
    const readyResult = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/ready`, {
      method: 'POST',
      body: { ready: true, concurrencyToken: result.concurrencyToken, expectedRoomVersion: result.room.roomVersion },
      headers: yandexAuthHeaders(isYandex.value),
      retry: 0
    })
    applyAuthoritativeState(readyResult.room, readyResult.concurrencyToken)
    joinSecret.value = ''
    joinPrompt.value = false
    socket.reconnect()
  } catch (error) {
    notice.value = friendlyError(error)
    if (seatingSucceeded) socket.reconnect()
  } finally {
    joinBusy.value = false
  }
}

async function mutate(path: 'ready' | 'sitting-out', payload: Record<string, unknown>) {
  if (!concurrencyToken.value) return
  try {
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/${path}`, { method: 'POST', body: { ...payload, concurrencyToken: concurrencyToken.value, expectedRoomVersion: state.value?.roomVersion }, headers: yandexAuthHeaders(isYandex.value), retry: 0 })
    applyAuthoritativeState(result.room, result.concurrencyToken)
    notice.value = ''
    socket.requestState()
  } catch (error) {
    notice.value = friendlyError(error)
    if (statusCode(error) === 409) await loadState()
  }
}

async function leave() {
  if (!concurrencyToken.value) return
  if (import.meta.client && !window.confirm('Выйти из этой комнаты?')) return
  try {
    await $fetch(`/api/online/rooms/${encodeURIComponent(code.value)}/leave`, { method: 'POST', body: { concurrencyToken: concurrencyToken.value, expectedRoomVersion: state.value?.roomVersion }, headers: yandexAuthHeaders(isYandex.value), retry: 0 })
    notice.value = ''
    socket.disconnect()
    await navigateTo(isYandex.value ? '/yandex' : '/rooms')
  } catch (error) {
    notice.value = friendlyError(error)
    if (statusCode(error) === 409) await loadState()
  }
}

async function changeStack(payload: { direction: 'ADD' | 'WITHDRAW'; amount: number; requestKey: string }) {
  if (stackOperationBusy.value) return
  stackOperationBusy.value = true
  try {
    const result = await $fetch<OnlineApiResult & { walletBalance: number }>(`/api/online/rooms/${encodeURIComponent(code.value)}/stack`, {
      method: 'POST', body: payload, headers: yandexAuthHeaders(isYandex.value), retry: 0
    })
    applyAuthoritativeState(result.room, result.concurrencyToken)
    walletBalance.value = result.walletBalance
    stackOperationResultKey.value += 1
    notice.value = ''
    socket.requestState()
  } catch (error) {
    notice.value = friendlyError(error)
    await loadState()
    try {
      const session = isYandex.value
        ? await $fetch<any>('/api/auth/yandex/session', { headers: yandexAuthHeaders(isYandex.value) })
        : await $fetch<any>('/api/auth/session')
      walletBalance.value = Number(session.user?.balance) || 0
    } catch { /* Keep the last known balance if the session refresh is unavailable. */ }
  } finally {
    stackOperationBusy.value = false
  }
}

onMounted(async () => {
  await account.loadSession()
  try {
    const user = isYandex.value
      ? await ensureYandexSession()
      : (await $fetch<{ user: any }>('/api/auth/session')).user
    if (user) {
      account.setUser(user)
      walletBalance.value = Number(user.balance) || 0
    }
  } catch { /* room endpoint reports auth state */ }
  await loadState()
  await loadSpectatorCount()
  spectatorPoll = setInterval(() => { void loadSpectatorCount() }, 5_000)
})

onBeforeUnmount(() => { if (spectatorPoll) clearInterval(spectatorPoll) })

useHead(() => ({ title: state.value ? `ONLINE ${state.value.roomCode} · Poker` : 'ONLINE · Poker' }))
</script>

<template>
  <main v-if="loading" class="online-state page-shell" role="status">Подключаемся к столу…</main>
  <main v-else-if="errorStatus" class="online-state page-shell">
    <section class="panel">
      <h1>{{ errorStatus === 'not-found' ? 'Стол не найден' : errorStatus === 'unauthorized' ? 'Нужен вход' : 'Не удалось открыть стол' }}</h1>
      <p>{{ errorStatus === 'unauthorized' ? (isYandex ? 'Гостевая сессия истекла. Вернитесь в игру и повторите подключение.' : 'Войдите в аккаунт и откройте ссылку на стол ещё раз.') : errorStatus === 'not-found' ? 'Проверьте код комнаты.' : 'Сервис временно недоступен. Попробуйте снова.' }}</p>
      <NuxtLink v-if="errorStatus === 'unauthorized' && isYandex" class="btn" to="/yandex">Вернуться в игру</NuxtLink>
      <NuxtLink v-else-if="errorStatus === 'unauthorized'" class="btn" :to="`/login?redirect=${encodeURIComponent(`/online/${code}`)}`">Войти</NuxtLink>
      <NuxtLink class="btn" :to="isYandex ? '/yandex' : '/rooms'">К списку столов</NuxtLink>
      <button v-if="errorStatus === 'unavailable' || errorStatus === 'error'" class="btn btn--ghost" type="button" @click="loadState">Повторить</button>
    </section>
  </main>
  <main v-else-if="joinPrompt" class="online-state page-shell">
    <section class="panel online-join-panel">
      <span class="eyebrow">ONLINE · {{ code }}</span>
      <h1>Войти за онлайн-стол</h1>
      <p>{{ privateRoom ? 'Введите пароль приглашения. Он не попадёт в адресную строку.' : 'Подтвердите вход, чтобы занять место за этим столом.' }}</p>
      <label v-if="privateRoom">Пароль
        <input v-model="joinSecret" class="input" type="password" autocomplete="current-password" maxlength="128" placeholder="Пароль комнаты">
      </label>
      <p v-if="notice || socketNotice" class="online-state__error" role="alert">{{ notice || socketNotice }}</p>
      <button class="btn" type="button" :disabled="joinBusy || (privateRoom && !joinSecret)" @click="joinRoom">{{ joinBusy ? 'Подключаем…' : 'Войти в комнату' }}</button>
      <NuxtLink class="btn btn--ghost" to="/rooms">Назад к столам</NuxtLink>
    </section>
  </main>
  <OnlinePokerTable
    v-else-if="state && (viewerIsMember || state.visibility === 'PUBLIC')"
    :state="state"
    :viewer-id="account.user?.id || null"
    :spectating="!viewerIsMember"
    :spectator-count="spectatorCount"
    :join-busy="joinBusy"
    :connection-status="connectionStatus"
    :pending-action-id="pendingActionId"
    :notice="notice || socketNotice"
    :can-start="canStart"
    :ready="ready"
    :sitting-out="sittingOut"
    :wallet-balance="walletBalance"
    :stack-operation-busy="stackOperationBusy"
    :stack-operation-result-key="stackOperationResultKey"
    @action="socket.sendAction"
    @start="socket.startHand"
    @ready="value => mutate('ready', { ready: value })"
    @sitting-out="value => mutate('sitting-out', { sittingOut: value })"
    @leave="leave"
    @join="joinRoom"
    @reconnect="socket.reconnect"
    @stack-operation="changeStack"
  />
</template>

<style scoped lang="scss">
.online-state { min-height: 52vh; display: grid; place-items: center; text-align: center; }
.online-state .panel { display: grid; gap: .7rem; max-width: 420px; justify-items: center; }
.online-state h1 { margin: 0; font-family: 'Space Grotesk', sans-serif; }
.online-state p { margin: 0; color: var(--text-muted); }
.online-join-panel { width: min(100%, 430px); }
.online-join-panel label { width: 100%; display: grid; gap: .35rem; text-align: left; color: var(--text-muted); }
.online-state__error { color: var(--danger) !important; }
</style>
