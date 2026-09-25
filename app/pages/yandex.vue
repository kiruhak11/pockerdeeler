<script setup lang="ts">
import OnlineLobbyDirectory from '~/components/room/OnlineLobbyDirectory.vue'
import type { PlatformPlayerIdentity } from '~/platform/types'
import { getBrowserYandexGamesAdapter, type YandexMockMode } from '~/platform/yandexGames'
import { applyYandexAccountSession, ensureYandexSession, readYandexSessionToken, saveYandexSession, yandexAuthHeaders } from '~/platform/yandexSession'
import type { AccountUser } from '~/types/account'

const runtimeConfig = useRuntimeConfig()
const route = useRoute()
const status = ref<'loading' | 'ready' | 'error'>('loading')
const identity = ref<PlatformPlayerIdentity | null>(null)
const accountAuthorized = ref(false)
const authorizationBusy = ref(false)
const errorMessage = ref('')
const rewardedProgress = ref({ viewsSinceGrant: 0, completedGrants: 0 })
const rewardedBusy = ref(false)
const rewardedNotice = ref('')
const rewardedError = ref('')
const playerInitials = computed(() => (identity.value?.displayName || 'Г').trim().slice(0, 1).toLocaleUpperCase('ru-RU'))

const configuredMock = computed<YandexMockMode>(() => {
  if (!import.meta.dev) return 'off'
  const value = String(runtimeConfig.public.yandexGamesMock || 'off')
  return value === 'guest' || value === 'authorized' ? value : 'off'
})

function adapter() {
  return getBrowserYandexGamesAdapter({ mockMode: configuredMock.value, production: import.meta.env.PROD })
}

async function refreshRewardedState() {
  const result = await $fetch<{ viewsSinceGrant: number; completedGrants: number }>('/api/yandex/rewarded/state', { headers: yandexAuthHeaders(), retry: 0 })
  rewardedProgress.value = { viewsSinceGrant: result.viewsSinceGrant, completedGrants: result.completedGrants }
}

async function initialize() {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    await adapter().initialize()
    identity.value = await adapter().getPlayerIdentity()
    await ensureYandexSession()
    await refreshRewardedState()
    const sessionToken = readYandexSessionToken()
    if (sessionToken) {
      const session = await $fetch<{ authorized: boolean }>('/api/auth/yandex/session', { headers: { Authorization: `Bearer ${sessionToken}` }, retry: 0 })
      accountAuthorized.value = session.authorized
    }
    status.value = 'ready'
    await nextTick()
    await adapter().gameReady()
  } catch {
    status.value = 'error'
    errorMessage.value = 'Не удалось подключиться к Яндекс Играм. Проверьте соединение и попробуйте ещё раз.'
  }
}

async function showRewardedVideo() {
  if (rewardedBusy.value || status.value !== 'ready' || route.path !== '/yandex') return
  rewardedBusy.value = true
  rewardedError.value = ''
  rewardedNotice.value = ''
  let attemptId: string | undefined
  let rewardedCallbackReceived = false
  try {
    const started = await $fetch<{ attemptId: string; status: string }>('/api/yandex/rewarded/start', {
      method: 'POST', body: { requestId: crypto.randomUUID() }, headers: yandexAuthHeaders(), retry: 0
    })
    if (started.status !== 'STARTED') throw new Error('Просмотр уже использован или истёк. Нажмите кнопку ещё раз.')
    attemptId = started.attemptId
    let completion: { viewsSinceGrant: number; completedGrants: number; grantedAmount: number; user: AccountUser } | undefined
    let completionFailed = false
    const outcome = await adapter().showRewardedVideo(async () => {
      rewardedCallbackReceived = true
      for (let retry = 0; retry < 2 && !completion; retry += 1) {
        try {
          completion = await $fetch(`/api/yandex/rewarded/${encodeURIComponent(attemptId!)}/complete`, { method: 'POST', headers: yandexAuthHeaders(), retry: 0 })
        } catch {
          if (retry === 1) completionFailed = true
        }
      }
    })
    if (!completion) {
      if (!rewardedCallbackReceived) await $fetch(`/api/yandex/rewarded/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST', headers: yandexAuthHeaders(), retry: 0 }).catch(() => undefined)
      if (rewardedCallbackReceived || completionFailed) {
        rewardedError.value = 'Просмотр прошёл, но подтверждение пока не получено. Обновите игру через несколько секунд.'
        await refreshRewardedState().catch(() => undefined)
      } else {
        rewardedError.value = outcome === 'error' ? 'Рекламу не удалось запустить. Попробуйте ещё раз.' : 'Просмотр не был засчитан. Чтобы получить награду, досмотрите видео.'
        await refreshRewardedState()
      }
      return
    }
    rewardedProgress.value = { viewsSinceGrant: completion.viewsSinceGrant, completedGrants: completion.completedGrants }
    applyYandexAccountSession(completion.user)
    rewardedNotice.value = completion.grantedAmount ? '+10 000 фишек' : 'Просмотр засчитан.'
  } catch (error) {
    rewardedError.value = error instanceof Error ? error.message : 'Не удалось выполнить просмотр. Попробуйте ещё раз.'
    if (!rewardedCallbackReceived) {
      if (attemptId) await $fetch(`/api/yandex/rewarded/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST', headers: yandexAuthHeaders(), retry: 0 }).catch(() => undefined)
      await refreshRewardedState().catch(() => undefined)
    }
  } finally {
    rewardedBusy.value = false
  }
}

async function authorize() {
  if (authorizationBusy.value) return
  authorizationBusy.value = true
  errorMessage.value = ''
  try {
    const authorized = await adapter().requestAuthorization()
    if (!authorized?.authorized || !authorized.signature) throw new Error('Signed Yandex player data is unavailable')
    const currentToken = readYandexSessionToken()
    if (!currentToken) throw new Error('Guest session is unavailable')
    const exchanged = await $fetch<{ user: AccountUser; token: string }>('/api/auth/yandex/exchange', {
      method: 'POST', body: { signature: authorized.signature },
      headers: { Authorization: `Bearer ${currentToken}` }, retry: 0
    })
    saveYandexSession(exchanged.user, exchanged.token)
    accountAuthorized.value = true
    identity.value = { ...authorized, signature: undefined }
    await refreshRewardedState()
  } catch {
    errorMessage.value = 'Авторизация не завершена. Можно продолжить как гость.'
  } finally {
    authorizationBusy.value = false
  }
}

onMounted(() => { void initialize() })
onBeforeUnmount(() => adapter().gameplayStop())
useHead({ title: 'Pocker · Яндекс Игры' })
</script>

<template>
  <main class="yandex-shell">
    <header class="yandex-shell__header">
      <div><span class="yandex-shell__mark">P</span><div><strong>Pocker</strong><small>ONLINE poker</small></div></div>
      <div v-if="status === 'ready' && identity" class="yandex-shell__player">
        <span class="yandex-shell__avatar" aria-hidden="true">{{ playerInitials }}</span>
        <div><strong>{{ identity.displayName || 'Гость' }}</strong><small>{{ accountAuthorized ? 'Игрок Яндекса' : 'Гостевой режим' }}</small></div>
        <button v-if="!accountAuthorized" type="button" :disabled="authorizationBusy" @click="authorize">{{ authorizationBusy ? 'Входим…' : 'Войти' }}</button>
      </div>
    </header>

    <section v-if="status === 'loading'" class="yandex-shell__state" role="status">
      <span class="yandex-shell__spinner" aria-hidden="true" />
      <h1>Готовим стол</h1><p>Подключаем игровую платформу…</p>
    </section>

    <section v-else-if="status === 'error'" class="yandex-shell__state" role="alert">
      <span class="yandex-shell__error-icon" aria-hidden="true">!</span>
      <h1>Не удалось запустить игру</h1><p>{{ errorMessage }}</p>
      <button class="btn" type="button" @click="initialize">Повторить</button>
    </section>

    <template v-else>
      <section class="yandex-shell__hero">
        <div><span>ONLINE</span><h1>Покерный стол<br>уже ждёт</h1><p>Играйте гостем или войдите через Яндекс по своему желанию.</p></div>
        <div class="yandex-shell__status"><i /><strong>Сеть доступна</strong><small>Общий multiplayer Pocker</small></div>
      </section>
      <p v-if="errorMessage" class="yandex-shell__notice" role="status">{{ errorMessage }}</p>
      <p class="yandex-shell__disclosure">Все выигрыши и награды в Pocker — только внутренняя виртуальная валюта. Она не выводится и не обменивается на реальные деньги или имущество.</p>
      <section class="yandex-reward" aria-labelledby="yandex-reward-title">
        <div><span class="yandex-reward__eyebrow">БОНУС ЗА РЕКЛАМУ</span><h2 id="yandex-reward-title">3 просмотра = 10 000 фишек</h2><p>Прогресс: {{ rewardedProgress.viewsSinceGrant }} / 3</p></div>
        <button class="btn" type="button" :disabled="rewardedBusy || route.path !== '/yandex'" @click="showRewardedVideo">{{ rewardedBusy ? 'Загрузка…' : 'Посмотреть рекламу' }}</button>
        <p class="yandex-reward__disclosure">Награда — внутренняя виртуальная валюта Pocker. Она не выводится и не обменивается на реальные деньги или имущество.</p>
        <p v-if="rewardedNotice" class="yandex-reward__notice" role="status">{{ rewardedNotice }}</p>
        <p v-if="rewardedError" class="yandex-reward__error" role="alert">{{ rewardedError }}</p>
      </section>
      <NuxtLink class="yandex-shell__create" to="/yandex/online/create">Создать онлайн-стол</NuxtLink>
      <OnlineLobbyDirectory platform-mode="yandex" />
      <small v-if="configuredMock !== 'off'" class="yandex-shell__dev">DEV MOCK · {{ configuredMock }}</small>
    </template>
  </main>
</template>

<style scoped lang="scss">
.yandex-shell { min-height: 100dvh; width: min(100%, 1040px); margin: 0 auto; padding: clamp(.75rem, 3vw, 1.5rem); display: grid; align-content: start; gap: 1rem; }
.yandex-shell__header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-width: 0; }
.yandex-shell__header > div, .yandex-shell__player { display: flex; align-items: center; gap: .7rem; min-width: 0; }
.yandex-shell__header strong, .yandex-shell__header small { display: block; }
.yandex-shell__header small { color: var(--text-muted); }
.yandex-shell__mark { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border-radius: 14px; color: #162218; background: var(--accent); font: 900 1.35rem 'Space Grotesk', sans-serif; }
.yandex-shell__player { margin-left: auto; padding: .4rem .5rem .4rem .7rem; border: 1px solid #ffffff1a; border-radius: 16px; background: #ffffff08; }
.yandex-shell__avatar { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: 50%; color: #172116; background: var(--accent); font-weight: 900; }
.yandex-shell__player button { min-height: 36px; padding: 0 .8rem; border: 0; border-radius: 11px; color: #172116; background: var(--accent); font-weight: 800; cursor: pointer; }
.yandex-shell__state { min-height: min(72dvh, 620px); display: grid; place-items: center; align-content: center; gap: .7rem; text-align: center; }
.yandex-shell__state h1, .yandex-shell__state p { margin: 0; }
.yandex-shell__state p { max-width: 470px; color: var(--text-muted); }
.yandex-shell__spinner { width: 42px; height: 42px; border: 4px solid #ffffff1a; border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
.yandex-shell__error-icon { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; color: white; background: var(--danger); font-weight: 900; }
.yandex-shell__hero { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 1rem; padding: clamp(1rem, 5vw, 2.5rem); border: 1px solid rgba(242,180,81,.26); border-radius: clamp(20px, 4vw, 32px); background: radial-gradient(circle at 85% 15%, rgba(242,180,81,.2), transparent 30%), linear-gradient(145deg, #194833, #0d251b); }
.yandex-shell__hero span { color: var(--accent); font-size: .72rem; font-weight: 900; letter-spacing: .18em; }
.yandex-shell__hero h1 { margin: .35rem 0 .7rem; font: 750 clamp(2.4rem, 8vw, 5.4rem)/.92 'Space Grotesk', sans-serif; letter-spacing: -.06em; }
.yandex-shell__hero p, .yandex-shell__foundation p { margin: 0; color: var(--text-muted); }
.yandex-shell__status { display: grid; grid-template-columns: auto 1fr; gap: .1rem .45rem; min-width: 190px; padding: .8rem; border-radius: 16px; background: #071a12a8; }
.yandex-shell__status i { grid-row: 1 / 3; align-self: center; width: 9px; height: 9px; border-radius: 50%; background: var(--success); }
.yandex-shell__status small { color: var(--text-muted); }
.yandex-shell__disclosure { margin: 0; color: var(--text-muted); font-size: .78rem; line-height: 1.4; }
.yandex-shell__create { justify-self: start; padding: .7rem 1rem; border-radius: 12px; color: #172116; background: var(--accent); font-weight: 800; }
.yandex-shell__notice { padding: .7rem .9rem; border-radius: 12px; color: var(--accent); background: rgba(242,180,81,.1); }
.yandex-reward { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .4rem 1rem; padding: 1rem; border: 1px solid rgba(242,180,81,.28); border-radius: 18px; background: rgba(242,180,81,.07); }
.yandex-reward h2, .yandex-reward p { margin: .2rem 0 0; }
.yandex-reward h2 { font-size: 1.05rem; }
.yandex-reward p { color: var(--text-muted); font-size: .84rem; }
.yandex-reward__eyebrow { color: var(--accent); font-size: .68rem; font-weight: 900; letter-spacing: .12em; }
.yandex-reward__disclosure, .yandex-reward__notice, .yandex-reward__error { grid-column: 1 / -1; }
.yandex-reward .yandex-reward__notice { color: var(--accent); font-weight: 800; }
.yandex-reward .yandex-reward__error { color: var(--danger); }
.yandex-shell__dev { justify-self: end; color: var(--text-muted); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 650px) { .yandex-shell__header { align-items: flex-start; } .yandex-shell__player { max-width: 70%; flex-wrap: wrap; justify-content: flex-end; } .yandex-shell__hero { grid-template-columns: 1fr; } .yandex-shell__status { min-width: 0; } .yandex-reward { grid-template-columns: 1fr; } .yandex-reward .btn { justify-self: start; } }
</style>
