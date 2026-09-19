<script setup lang="ts">
import type { AccountUser, RewardState } from '~/types/account'
import { useAccountStore } from '~/stores/account'
import { getHttpErrorMessage } from '~/utils/httpError'

interface SavedReward {
  requestId: string
  id?: string
  intent: 'view' | 'complete' | 'cancel'
}
const props = defineProps<{ inGame?: boolean }>()
const account = useAccountStore()
const { loadMe } = useAccountAuth()
const state = ref<RewardState | null>(null)
const pending = ref<SavedReward | null>(null)
const busy = ref(false)
const error = ref('')
const message = ref('')
const now = ref(Date.now())
const dialog = ref<HTMLDialogElement | null>(null)
const showing = ref(false)
const elapsed = ref(0)
const paused = ref(false)
let frame = 0
let lastFrame = 0
let interval: ReturnType<typeof setInterval> | undefined
let nextSync = 0
let failures = 0
let disposed = false
let opener: HTMLElement | null = null
const storageKey = computed(() => `poker-selfpromo-v1:${account.user?.id || 'guest'}`)
const remaining = computed(() => Math.max(0, Math.ceil((10000 - elapsed.value) / 1000)))
const nextTime = computed(() => state.value?.nextAvailableAt ? new Date(state.value.nextAvailableAt).toLocaleString('ru-RU') : '')
const isTerminal = (status?: string) => ['completed', 'granted', 'cancelled', 'canceled', 'expired', 'failed'].includes(status || '')
const isGranted = (status?: string) => ['completed', 'granted'].includes(status || '')
const activeAttempt = computed(() => state.value?.attempt && !isTerminal(state.value.attempt.status) ? state.value.attempt : null)
const eliteReady = computed(() => Boolean(state.value?.elite && (!state.value.attempt || state.value.eliteAttempt)))
const canStart = computed(() => state.value?.enabled && state.value.available && account.user?.phoneVerified && !props.inGame && !pending.value && !activeAttempt.value)

function persist() {
  if (pending.value) localStorage.setItem(storageKey.value, JSON.stringify(pending.value))
  else localStorage.removeItem(storageKey.value)
}
function restore() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey.value) || 'null') as SavedReward | null
    pending.value = value && typeof value.requestId === 'string' && ['view', 'complete', 'cancel'].includes(value.intent) ? value : null
  } catch { pending.value = null }
}
function closeViewer() {
  showing.value = false
  cancelAnimationFrame(frame)
  dialog.value?.close()
  opener?.focus()
}
async function acceptState(result: RewardState) {
  state.value = result
  const attempt = result.attempt
  if (!attempt && pending.value?.id && pending.value.intent === 'view') {
    pending.value = null
    persist()
    closeViewer()
    await loadMe()
    message.value = 'Предыдущая попытка больше не активна. Кошелёк обновлён.'
  }
  if (attempt && isGranted(attempt.status)) {
    // Refresh the wallet from the server, including when a completion response was lost.
    await loadMe()
    if (pending.value?.id === attempt.id || showing.value) message.value = `Начислено ${attempt.amount.toLocaleString('ru-RU')} фишек в свободный кошелёк.`
  }
  if (attempt && isTerminal(attempt.status)) {
    if (pending.value?.id === attempt.id || (!pending.value?.id && pending.value)) {
      pending.value = null
      persist()
    }
    closeViewer()
  } else if (attempt && !pending.value) {
    pending.value = { requestId: crypto.randomUUID(), id: attempt.id, intent: 'view' }
    persist()
  } else if (attempt && pending.value && !pending.value.id) {
    pending.value.id = attempt.id
    persist()
  }
}
async function synchronize() {
  if (busy.value || !account.user || disposed) return
  busy.value = true
  try {
    await acceptState(await $fetch<RewardState>('/api/rewards/state', { retry: 0 }))
    // Never replace an unresolved completion with a fresh viewing attempt.
    if (pending.value?.id && pending.value.intent === 'complete') await finishRequest()
    else if (state.value?.eliteAttempt && activeAttempt.value) {
      pending.value = { requestId: crypto.randomUUID(), id: activeAttempt.value.id, intent: 'complete' }
      persist()
      await finishRequest()
    }
    else if (pending.value?.id && pending.value.intent === 'cancel') await cancelRequest()
    failures = 0
    error.value = ''
  } catch (e) {
    failures++
    error.value = getHttpErrorMessage(e, 'Не удалось проверить бонус. Попытка сохранена, повторный просмотр не нужен после зачисления.')
  } finally {
    nextSync = Date.now() + Math.min(120000, 15000 * 2 ** failures)
    busy.value = false
  }
}
async function finishRequest() {
  if (!pending.value?.id) return
  const awardedAmount = state.value?.attempt?.amount ?? state.value?.amount ?? 0
  const result = await $fetch<{ user: AccountUser; state: RewardState }>('/api/rewards/complete', {
    method: 'POST', body: { id: pending.value.id }, retry: 0
  })
  account.setUser(result.user)
  state.value = result.state
  message.value = `Начислено ${awardedAmount.toLocaleString('ru-RU')} фишек в свободный кошелёк.`
  pending.value = null
  persist()
  closeViewer()
}
async function complete() {
  if (busy.value || !pending.value?.id || elapsed.value < 10000 || !showing.value || document.visibilityState !== 'visible' || !document.hasFocus()) return
  busy.value = true
  error.value = ''
  try {
    pending.value.intent = 'complete'
    persist()
    closeViewer()
    await finishRequest()
  } catch (e) {
    error.value = getHttpErrorMessage(e, 'Ответ о зачислении потерян. Проверьте результат: повторный просмотр не требуется.')
  } finally { busy.value = false; nextSync = Date.now() + 5000 }
}
function tick(timestamp: number) {
  if (!showing.value || disposed) return
  const delta = lastFrame ? timestamp - lastFrame : 0
  lastFrame = timestamp
  paused.value = document.visibilityState !== 'visible' || !document.hasFocus()
  // Large frame gaps can be device sleep; never count them as visible viewing time.
  if (!paused.value && delta > 0 && delta < 1000) elapsed.value = Math.min(10000, elapsed.value + delta)
  const attempt = activeAttempt.value
  now.value = Date.now()
  if (attempt && Date.parse(attempt.expiresAt) <= now.value) {
    closeViewer()
    error.value = 'Срок просмотра истёк. Проверьте состояние бонуса.'
    void synchronize()
    return
  }
  if (elapsed.value >= 10000 && attempt && Date.parse(attempt.readyAt) <= now.value && navigator.onLine) void complete()
  frame = requestAnimationFrame(tick)
}
async function openViewer() {
  if (disposed || !activeAttempt.value || !pending.value || pending.value.intent !== 'view' || props.inGame || !account.user?.phoneVerified) return
  elapsed.value = 0
  lastFrame = 0
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  showing.value = true
  await nextTick()
  dialog.value?.showModal()
  frame = requestAnimationFrame(tick)
}
async function startOrResume() {
  if (busy.value || props.inGame || !account.user?.phoneVerified) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await acceptState(await $fetch<RewardState>('/api/rewards/state', { retry: 0 }))
    if (pending.value?.intent === 'complete') { await finishRequest(); return }
    if (pending.value?.intent === 'cancel') { await cancelRequest(); return }
    if (!activeAttempt.value) {
      if (!state.value?.enabled || !state.value.available) return
      if (!pending.value) pending.value = { requestId: crypto.randomUUID(), intent: 'view' }
      persist()
      const started = await $fetch<RewardState>('/api/rewards/start', { method: 'POST', body: { requestId: pending.value.requestId }, retry: 0 })
      await acceptState(started)
      if (!activeAttempt.value && pending.value?.intent === 'view') {
        pending.value = null
        persist()
        message.value = 'Эта попытка уже завершена или истекла. Состояние обновлено.'
      }
      if (started.eliteAttempt && started.attempt) {
        pending.value = { requestId: pending.value?.requestId || crypto.randomUUID(), id: started.attempt.id, intent: 'complete' }
        persist()
        await finishRequest()
        return
      }
    }
    if (state.value?.eliteAttempt && activeAttempt.value) {
      pending.value = { requestId: crypto.randomUUID(), id: activeAttempt.value.id, intent: 'complete' }
      persist()
      await finishRequest()
      return
    }
    await openViewer()
  } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось открыть просмотр. Повторите эту же попытку.') }
  finally { busy.value = false }
}
async function cancelRequest() {
  if (!pending.value?.id) return
  const result = await $fetch<RewardState>('/api/rewards/cancel', { method: 'POST', body: { id: pending.value.id }, retry: 0 })
  await acceptState(result)
  await loadMe()
  pending.value = null
  persist()
  if (!isGranted(result.attempt?.status)) message.value = 'Просмотр закрыт без запроса бонуса. Состояние кошелька обновлено.'
}
async function cancel() {
  if (busy.value || !pending.value?.id) return
  closeViewer()
  busy.value = true
  try {
    pending.value.intent = 'cancel'
    persist()
    await cancelRequest()
    error.value = ''
  } catch (e) { error.value = getHttpErrorMessage(e, 'Отмена сохранена. Повторите при восстановлении сети; бонус не запрашивался.') }
  finally { busy.value = false }
}
function resume() {
  lastFrame = 0
  paused.value = document.visibilityState !== 'visible' || !document.hasFocus()
  if (!paused.value && navigator.onLine && !showing.value) void synchronize()
}
onMounted(() => {
  restore()
  void synchronize()
  interval = setInterval(() => {
    now.value = Date.now()
    if (!showing.value && document.visibilityState === 'visible' && navigator.onLine && now.value >= nextSync) void synchronize()
  }, 1000)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('focus', resume)
  window.addEventListener('blur', resume)
  window.addEventListener('online', resume)
  window.addEventListener('pageshow', resume)
})
watch(() => props.inGame, (value) => { if (value && showing.value) void cancel() })
watch(() => account.user?.id, () => {
  closeViewer()
  state.value = null
  restore()
  void synchronize()
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(interval)
  cancelAnimationFrame(frame)
  document.removeEventListener('visibilitychange', resume)
  window.removeEventListener('focus', resume)
  window.removeEventListener('blur', resume)
  window.removeEventListener('online', resume)
  window.removeEventListener('pageshow', resume)
  if (showing.value && pending.value?.id && pending.value.intent === 'view') {
    pending.value.intent = 'cancel'
    try { persist() } catch { /* The server will expire the attempt without a grant. */ }
    void fetch('/api/rewards/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: pending.value.id }), credentials: 'same-origin', keepalive: true }).catch(() => {})
  }
  dialog.value?.close()
})
</script>

<template>
  <section v-if="account.user" class="panel daily-bonus">
    <div>
      <span class="tag">{{ state?.elite ? 'Premium Elite · ежедневный бонус' : 'Бонус за знакомство с сайтом' }}</span>
      <h3>{{ eliteReady ? '+15 000 фишек без просмотра' : state ? `+${state.attempt?.amount ?? state.amount} фишек` : 'Фишки за 10 секунд' }}</h3>
      <p>{{ eliteReady ? 'Активный Premium Elite даёт 15 000 виртуальных фишек раз в сутки без просмотра. Начисление выполняется сервером.' : 'Короткое сообщение о Poker Dealer Desk. Без сторонней рекламы. Бонус пополняет только свободный кошелёк, не стек и не банк за столом.' }}</p>
      <p v-if="!account.user.phoneVerified">Сначала подтвердите телефон в <NuxtLink to="/profile">профиле</NuxtLink>.</p>
      <p v-else-if="props.inGame">Просмотр недоступен во время игры. Вернитесь после расчёта раздачи.</p>
      <p v-else-if="state && !state.enabled">Бонус временно отключён.</p>
      <p v-if="state?.reason">{{ state.reason }}</p>
      <p v-if="nextTime && !state?.available">Следующий бонус: {{ nextTime }}</p>
    </div>
    <button v-if="pending?.intent === 'complete' || pending?.intent === 'cancel'" class="btn" :disabled="busy" @click="synchronize">{{ pending.intent === 'complete' ? 'Проверить зачисление без повторного просмотра' : 'Завершить отмену' }}</button>
    <button v-else class="btn" :disabled="busy || !account.user.phoneVerified || props.inGame || (!canStart && !pending && !activeAttempt)" @click="startOrResume">{{ busy ? 'Проверяем...' : eliteReady ? 'Получить 15 000' : pending || activeAttempt ? 'Продолжить сохранённую попытку' : 'Посмотреть 10 секунд' }}</button>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="daily-bonus__error" role="alert">{{ error }}</p>
    <button v-if="error || !state" class="btn btn--ghost" :disabled="busy" @click="synchronize">Обновить состояние</button>
    <dialog ref="dialog" class="daily-bonus__dialog" aria-labelledby="selfpromo-title" aria-describedby="selfpromo-description" @cancel.prevent="cancel">
      <div class="daily-bonus__promo">
        <span class="tag">О нашем сайте · 10 секунд</span>
        <h2 id="selfpromo-title">Карты настоящие.<br>Фишки всегда под рукой.</h2>
        <p id="selfpromo-description">Poker Dealer Desk помогает провести покерный вечер с друзьями. Создайте комнату, пригласите игроков по коду и делайте ставки со своих телефонов.</p>
        <ul>
          <li>Сайт считает стеки, ставки и общий банк.</li>
          <li>Дилер ведёт игру и указывает победителя.</li>
          <li>Баланс и история доступны в вашем аккаунте.</li>
        </ul>
        <p>Полезный сайт для вашей компании. Никаких платежей и сторонней рекламы.</p>
        <progress :value="elapsed" max="10000" aria-label="Время просмотра в открытом окне" />
        <p role="status">{{ paused ? 'Пауза. Вернитесь в окно просмотра.' : remaining ? `Осталось ${remaining} сек. в открытом окне` : 'Проверяем готовность сервера...' }}</p>
        <p>Если закрыть раньше, бонус не начисляется. В фоне таймер стоит на паузе.</p>
        <button class="btn btn--ghost" :disabled="busy" autofocus @click="cancel">Закрыть без бонуса</button>
      </div>
    </dialog>
  </section>
</template>

<style scoped lang="scss">
.daily-bonus {
  display: grid; gap: 0.8rem; background: linear-gradient(115deg, #1c412e, #15291d);
  h3 { margin: 0.6rem 0; } p { margin: 0.4rem 0; color: var(--text-muted); line-height: 1.5; }
  > button { justify-self: start; } .btn { min-height: 46px; white-space: normal; }
  p#{&}__error { color: var(--danger); }
  &__dialog { color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--accent); border-radius: var(--radius-lg); width: min(540px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); padding: 0; overscroll-behavior: contain; &::backdrop { background: rgb(0 0 0 / 75%); } }
  &__promo { display: grid; gap: 0.8rem; padding: 1.4rem; background: radial-gradient(ellipse at top right, #365d3b, transparent 65%); h2 { font-family: 'Space Grotesk', sans-serif; font-size: clamp(1.5rem, 5vw, 2rem); margin: 0; } ul { padding-left: 1.2rem; margin: 0; line-height: 1.7; } progress { width: 100%; height: 12px; accent-color: var(--accent); } }
}
</style>
