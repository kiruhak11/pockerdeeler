<script setup lang="ts">
import OnlinePokerTable from '~/components/online/OnlinePokerTable.vue'
import { useAccountStore } from '~/stores/account'
import { useOnlineRoomSocket } from '~/composables/useOnlineRoomSocket'
import type { OnlineApiResult, OnlineRoomState } from '~/types/online'

const route = useRoute()
const account = useAccountStore()
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

const socket = useOnlineRoomSocket(code, {
  onState(next) {
    state.value = next
    const player = next.pokerTable.players.find(candidate => candidate.playerId === account.user?.id)
    privateRoom.value = next.visibility === 'PRIVATE'
    joinPrompt.value = !player
    ready.value = player?.ready ?? false
    sittingOut.value = player?.sittingOut ?? false
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
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/state`, { retry: 0 })
    state.value = result.room
    concurrencyToken.value = result.concurrencyToken
    const player = result.room.pokerTable.players.find(candidate => candidate.playerId === account.user?.id)
    privateRoom.value = result.room.visibility === 'PRIVATE'
    joinPrompt.value = !player
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

async function joinRoom() {
  if (joinBusy.value || !account.user) {
    if (!account.user) await navigateTo(`/login?redirect=${encodeURIComponent(`/online/${code.value}`)}`)
    return
  }
  joinBusy.value = true
  notice.value = ''
  try {
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/join`, {
      method: 'POST',
      body: {
        ...(concurrencyToken.value ? { concurrencyToken: concurrencyToken.value } : {}),
        ...(state.value?.roomVersion === undefined ? {} : { expectedRoomVersion: state.value.roomVersion }),
        ...(joinSecret.value ? { joinSecret: joinSecret.value } : {})
      },
      retry: 0
    })
    state.value = result.room
    concurrencyToken.value = result.concurrencyToken
    joinSecret.value = ''
    joinPrompt.value = false
    socket.reconnect()
  } catch (error) {
    notice.value = friendlyError(error)
  } finally {
    joinBusy.value = false
  }
}

async function mutate(path: 'ready' | 'sitting-out', payload: Record<string, unknown>) {
  if (!concurrencyToken.value) return
  try {
    const result = await $fetch<OnlineApiResult>(`/api/online/rooms/${encodeURIComponent(code.value)}/${path}`, { method: 'POST', body: { ...payload, concurrencyToken: concurrencyToken.value, expectedRoomVersion: state.value?.roomVersion }, retry: 0 })
    state.value = result.room
    concurrencyToken.value = result.concurrencyToken
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
    await $fetch(`/api/online/rooms/${encodeURIComponent(code.value)}/leave`, { method: 'POST', body: { concurrencyToken: concurrencyToken.value, expectedRoomVersion: state.value?.roomVersion }, retry: 0 })
    socket.disconnect()
    await navigateTo('/rooms')
  } catch (error) {
    notice.value = friendlyError(error)
    if (statusCode(error) === 409) await loadState()
  }
}

onMounted(async () => {
  await account.loadSession()
  try { await $fetch('/api/auth/session').then((response: any) => account.setUser(response.user)) } catch { /* room endpoint reports auth state */ }
  await loadState()
})

useHead(() => ({ title: state.value ? `ONLINE ${state.value.roomCode} · Poker` : 'ONLINE · Poker' }))
</script>

<template>
  <main v-if="loading" class="online-state page-shell" role="status">Подключаемся к столу…</main>
  <main v-else-if="errorStatus" class="online-state page-shell">
    <section class="panel">
      <h1>{{ errorStatus === 'not-found' ? 'Стол не найден' : errorStatus === 'unauthorized' ? 'Нужен вход' : 'Не удалось открыть стол' }}</h1>
      <p>{{ errorStatus === 'unauthorized' ? 'Войдите в аккаунт и откройте ссылку на стол ещё раз.' : errorStatus === 'not-found' ? 'Проверьте код комнаты.' : 'Сервис временно недоступен. Попробуйте снова.' }}</p>
      <NuxtLink v-if="errorStatus === 'unauthorized'" class="btn" :to="`/login?redirect=${encodeURIComponent(`/online/${code}`)}`">Войти</NuxtLink>
      <NuxtLink class="btn" to="/rooms">К списку столов</NuxtLink>
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
    v-else-if="state && viewerIsMember"
    :state="state"
    :viewer-id="account.user?.id || null"
    :connection-status="connectionStatus"
    :pending-action-id="pendingActionId"
    :notice="notice || socketNotice"
    :can-start="canStart"
    :ready="ready"
    :sitting-out="sittingOut"
    @action="socket.sendAction"
    @start="socket.startHand"
    @ready="value => mutate('ready', { ready: value })"
    @sitting-out="value => mutate('sitting-out', { sittingOut: value })"
    @leave="leave"
    @reconnect="socket.reconnect"
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
