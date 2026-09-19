<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { formatRussianPhone, useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { FriendItem, FriendRequestItem, RoomInviteItem } from '~/types/social'
import DailyBonus from '~/components/account/DailyBonus.vue'
import WalletHistoryModal from '~/components/account/WalletHistoryModal.vue'
import type { AchievementResponse, AchievementView } from '~/types/achievement'
import type { PremiumAccess } from '~/types/premium'
import AppIcon from '~/components/ui/AppIcon.vue'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'
import PremiumBadge from '~/components/premium/PremiumBadge.vue'

const accountStore = useAccountStore()
const { loadMe, updateUsername, logout } = useAccountAuth()

const loading = ref(false)
const initializing = ref(true)
const errorMessage = ref('')
const successMessage = ref('')
const transferAmounts = reactive<Record<string, number>>({})
const transferBusy = ref<string | null>(null)

const usernameForm = reactive({
  username: ''
})

const friendUsername = ref('')
const socialLoadError = ref(false)
const friends = ref<FriendItem[]>([])
const requests = ref<FriendRequestItem[]>([])
const invites = ref<RoomInviteItem[]>([])
const achievements = ref<AchievementView[]>([])
const season = ref<any>(null)
const walletHistory = ref<any>(null)
const walletHistoryOpen = ref(false)
const walletHistoryLoading = ref(false)
const achievementsOpen = ref(false)
const premiumAccess = ref<PremiumAccess | null>(null)
const premiumPreferences = ref<Record<string, unknown>>({})
const unlockedAchievements = computed(() => achievements.value.filter(item => item.unlocked).length)
const achievementRarityOrder: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }
const sortedAchievements = computed(() => [...achievements.value].sort((a, b) => Number(Boolean(b.seasonal)) - Number(Boolean(a.seasonal)) || (achievementRarityOrder[a.rarity] ?? 99) - (achievementRarityOrder[b.rarity] ?? 99) || a.title.localeCompare(b.title, 'ru')))
const selectedAchievement = computed(() => achievements.value.find(item => item.code === accountStore.user?.selectedAchievementCode))
const tableWinRate = computed(() => {
  const played = accountStore.user?.tableHandsPlayed || 0
  return played ? Math.round((accountStore.user?.tableHandsWon || 0) * 100 / played) : 0
})
const predictionSuccessRate = computed(() => {
  const count = accountStore.user?.predictionCount || 0
  return count ? Math.round((accountStore.user?.predictionWins || 0) * 100 / count) : 0
})
const premiumLabel = computed(() => premiumAccess.value?.plan === 'ELITE' ? 'Elite' : premiumAccess.value?.active ? 'Premium' : '')
const identityPremiumClasses = computed(() => {
  if (!premiumAccess.value?.active) return []
  const classes = ['identity-card--premium']
  const frame = String(premiumPreferences.value.frame || 'none')
  if (['gold', 'emerald', 'obsidian'].includes(frame)) classes.push(`identity-card--frame-${frame}`)
  if (premiumAccess.value.plan === 'ELITE' && premiumPreferences.value.animatedFrame) classes.push('identity-card--animated')
  const preset = String(premiumPreferences.value.profilePreset || '')
  if (premiumAccess.value.plan === 'ELITE' && ['royal', 'neon'].includes(preset)) classes.push(`identity-card--preset-${preset}`)
  return classes
})
const premiumNameClass = computed(() => premiumAccess.value?.plan === 'ELITE' && premiumPreferences.value.nameColor
  ? `identity-card__name--${String(premiumPreferences.value.nameColor)}`
  : '')

const incomingRequests = computed(() => requests.value.filter((item) => item.direction === 'incoming' && item.status === 'pending'))
const outgoingRequests = computed(() => requests.value.filter((item) => item.direction === 'outgoing'))

const isAuthenticated = computed(() => Boolean(accountStore.token && accountStore.user))

async function loadSocialData() {
  if (!accountStore.token) {
    return
  }

  socialLoadError.value = false
  const [friendsResponse, requestsResponse, invitesResponse] = await Promise.all([
    $fetch<{ friends: FriendItem[] }>('/api/friends/list', {
      method: 'POST',
      body: { token: accountStore.token }
    }),
    $fetch<{ requests: FriendRequestItem[] }>('/api/friends/requests', {
      method: 'POST',
      body: { token: accountStore.token }
    }),
    $fetch<{ invites: RoomInviteItem[] }>('/api/invites/list', {
      method: 'POST',
      body: { token: accountStore.token }
    })
  ])

  friends.value = friendsResponse.friends
  requests.value = requestsResponse.requests
  invites.value = invitesResponse.invites
}

async function loadAchievementData() {
  const achievementsResponse = await $fetch<AchievementResponse>('/api/auth/achievements')
  achievements.value = achievementsResponse.achievements
  if (accountStore.user) accountStore.user.selectedAchievementCode = achievementsResponse.selectedCode
}
async function loadSeasonData() { season.value = await $fetch('/api/season/me') }
async function openWalletHistory() {
  walletHistoryOpen.value = true
  walletHistoryLoading.value = true
  try { walletHistory.value = await $fetch('/api/auth/wallet-history?limit=500') }
  catch (error) { errorMessage.value = getHttpErrorMessage(error, 'Не удалось загрузить историю баланса') }
  finally { walletHistoryLoading.value = false }
}
const formatSeasonValue = (value: unknown) => Number(value || 0).toLocaleString('ru-RU')

async function selectAchievement(code: string | null) {
  await $fetch('/api/auth/achievements/select', { method: 'POST', body: { code } })
  if (accountStore.user) accountStore.user.selectedAchievementCode = code
}

async function initialize() {
  accountStore.loadSession()

  loading.value = true
  errorMessage.value = ''

  try {
    const user = await loadMe()
    if (!user) return
    usernameForm.username = accountStore.user?.username || ''
    const premiumResult = await Promise.allSettled([
      $fetch<PremiumAccess>('/api/premium/me'),
      $fetch<{ settings: Record<string, unknown> | null }>('/api/premium/preferences')
    ])
    premiumAccess.value = premiumResult[0].status === 'fulfilled' ? premiumResult[0].value : null
    premiumPreferences.value = premiumResult[1].status === 'fulfilled' ? premiumResult[1].value.settings || {} : {}
    const [socialResult, achievementResult, seasonResult] = await Promise.allSettled([loadSocialData(), loadAchievementData(), loadSeasonData()])
    if (socialResult.status === 'rejected' && achievementResult.status === 'rejected' && seasonResult.status === 'rejected') throw achievementResult.reason
    if (socialResult.status === 'rejected') {
      socialLoadError.value = true
      errorMessage.value = getHttpErrorMessage(socialResult.reason, 'Не удалось загрузить друзей и заявки')
    }
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось загрузить данные профиля')
  } finally {
    loading.value = false
    initializing.value = false
  }
}

async function onUpdateUsername() {
  if (!accountStore.token) {
    return
  }

  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    const user = await updateUsername(usernameForm.username)
    usernameForm.username = user.username
    successMessage.value = 'Имя пользователя обновлено'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось обновить имя')
  } finally {
    loading.value = false
  }
}

async function logoutAccount() {
  if (loading.value) return
  loading.value = true
  errorMessage.value = ''
  try { await logout(); await navigateTo('/login') }
  catch (error) { errorMessage.value = getHttpErrorMessage(error, 'Не удалось выйти. Повторите при восстановлении сети.') }
  finally { loading.value = false }
}

async function onSendFriendRequest() {
  if (!accountStore.token || !friendUsername.value.trim()) {
    return
  }

  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    await $fetch('/api/friends/request', {
      method: 'POST',
      body: {
        token: accountStore.token,
        username: friendUsername.value.trim()
      }
    })

    friendUsername.value = ''
    await loadSocialData()
    successMessage.value = 'Заявка в друзья отправлена'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось отправить заявку')
  } finally {
    loading.value = false
  }
}

async function onRespondRequest(requestId: string, decision: 'accept' | 'reject') {
  if (!accountStore.token) {
    return
  }

  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    await $fetch('/api/friends/respond', {
      method: 'POST',
      body: {
        token: accountStore.token,
        requestId,
        decision
      }
    })

    await loadSocialData()
    successMessage.value = decision === 'accept' ? 'Заявка принята' : 'Заявка отклонена'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось обработать заявку')
  } finally {
    loading.value = false
  }
}

async function onTransfer(friendUserId: string) {
  if (!accountStore.token) return
  const amount = Number(transferAmounts[friendUserId] || 0)
  if (!Number.isSafeInteger(amount) || amount < 1) return
  transferBusy.value = friendUserId
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = await $fetch<{ balance: number; friend: { username: string }; amount: number }>('/api/friends/transfer', { method: 'POST', body: { token: accountStore.token, friendUserId, amount, requestId: crypto.randomUUID() } })
    if (accountStore.user) accountStore.user.balance = result.balance
    transferAmounts[friendUserId] = 0
    successMessage.value = `Перевод ${result.amount.toLocaleString('ru-RU')} фишек отправлен пользователю ${result.friend.username}`
    await loadSocialData()
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось выполнить перевод')
  } finally {
    transferBusy.value = null
  }
}

async function onDeleteFriend(friendshipId: string) {
  if (!accountStore.token || loading.value || !window.confirm('Удалить пользователя из друзей?')) return
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    await $fetch('/api/friends/delete', { method: 'POST', body: { token: accountStore.token, friendshipId } })
    await loadSocialData()
    successMessage.value = 'Пользователь удалён из друзей'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось удалить друга')
  } finally {
    loading.value = false
  }
}

async function onRespondInvite(inviteId: string, decision: 'accept' | 'decline') {
  if (!accountStore.token) {
    return
  }

  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    const result = await $fetch<{ joinUrl: string | null }>('/api/invites/respond', {
      method: 'POST',
      body: {
        token: accountStore.token,
        inviteId,
        decision
      }
    })

    await loadSocialData()

    if (decision === 'accept' && result.joinUrl) {
      successMessage.value = 'Приглашение принято. Открываем комнату...'
      await navigateTo(result.joinUrl)
      return
    }

    successMessage.value = decision === 'accept' ? 'Приглашение принято' : 'Приглашение отклонено'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось обработать приглашение')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  initialize()
})
</script>

<template>
  <main class="page-shell profile-page">
    <header class="profile-hero">
      <div class="profile-hero__top">
        <div>
          <p class="profile-hero__eyebrow">Pocker · личный кабинет</p>
          <h1 class="page-title">Ваш игровой профиль</h1>
          <p class="page-subtitle">Всё важное об аккаунте, прогрессе и игровой экономике — в одном месте.</p>
        </div>
        <nav class="profile-tabs" aria-label="Разделы профиля">
          <NuxtLink class="is-active" to="/profile">Профиль</NuxtLink>
          <NuxtLink to="/settings">Настройки</NuxtLink>
        </nav>
      </div>
      <div class="profile-hero__signals" aria-label="Сводка аккаунта">
        <span><i class="profile-signal__dot profile-signal__dot--live" /> Игровой аккаунт</span>
        <span><i class="profile-signal__dot" /> Виртуальная валюта</span>
      </div>
    </header>

    <p v-if="errorMessage" class="profile-page__error" role="alert">{{ errorMessage }}</p>
    <p v-if="successMessage" class="profile-page__success" role="status">{{ successMessage }}</p>
    <p v-if="initializing" role="status">Проверяем сессию...</p>
    <button v-if="errorMessage" class="btn btn--ghost" :disabled="loading" @click="initialize">Обновить профиль</button>
    <section v-if="!isAuthenticated && !initializing" class="panel profile-page__panel">
      <p>Вы не авторизованы.</p>
      <NuxtLink class="btn" to="/login">Войти по телефону</NuxtLink>
    </section>

    <template v-if="isAuthenticated">
      <section class="profile-dashboard">
        <section class="profile-top-grid" aria-label="Основная информация">
          <article class="panel identity-card" :class="identityPremiumClasses">
            <div class="identity-card__avatar"><AchievementBadge v-if="selectedAchievement?.code" :code="selectedAchievement.code" :size="42"/><span v-else>{{ accountStore.user?.username.slice(0, 1).toUpperCase() }}</span></div>
            <div class="identity-card__body">
              <div class="identity-card__name" :class="premiumNameClass"><h2>{{ accountStore.user?.username }}</h2><span v-if="premiumLabel" :class="{ 'is-elite': premiumAccess?.plan === 'ELITE' }">{{ premiumLabel }}</span></div>
              <p>{{ selectedAchievement?.title || 'Игровой профиль готов к новым достижениям' }}</p>
              <p class="identity-card__phone">{{ formatRussianPhone(accountStore.user?.phone) }} · {{ accountStore.user?.phoneVerified ? 'телефон подтверждён' : 'телефон не подтверждён' }}</p>
            </div>
            <div class="identity-card__actions"><NuxtLink class="text-action" to="/settings">Настройки профиля <AppIcon name="arrow-right" :size="14"/></NuxtLink><NuxtLink v-if="accountStore.user?.role === 'ADMIN' || accountStore.user?.role === 'SUPERADMIN'" class="text-action" to="/admin">Админ-панель <AppIcon name="arrow-right" :size="14"/></NuxtLink></div>
          </article>
          <article class="panel balance-card">
            <div class="balance-card__heading"><div><p class="section-kicker">БАЛАНС</p><h2>Ваши фишки</h2></div><span class="balance-card__coin">◈</span></div>
            <button type="button" class="balance-card__amount" @click="openWalletHistory"><strong>{{ accountStore.user?.balance.toLocaleString('ru-RU') }}</strong><span>виртуальных фишек · открыть историю</span></button>
            <div class="balance-card__actions"><NuxtLink class="btn balance-card__primary" to="/payments/virtual-currency">Пополнить фишки <span>＋</span></NuxtLink><NuxtLink class="balance-card__history" to="/payments/history">История операций <AppIcon name="arrow-right" :size="16" /></NuxtLink></div>
          </article>
        </section>

        <section class="profile-metrics" aria-label="Рейтинги">
          <article><span class="metric-icon">♠</span><div><small>Игра за столом</small><strong>{{ accountStore.user?.tableRating.toLocaleString('ru-RU') }}</strong><span class="table-record"><b class="table-record__wins">{{ tableWinRate }}% побед</b></span></div></article>
          <article><span class="metric-icon metric-icon--violet">✦</span><div><small>Рейтинг прогнозов</small><strong>{{ accountStore.user?.predictionRating.toLocaleString('ru-RU') }}</strong><span>{{ accountStore.user?.predictionWins || 0 }} точных из {{ accountStore.user?.predictionCount || 0 }}</span></div></article>
          <article><span class="metric-icon metric-icon--green">◆</span><div><small>Ачивки</small><strong>{{ unlockedAchievements }}<i>/{{ achievements.length }}</i></strong><span>открыто наград</span></div></article>
        </section>

        <section class="profile-block profile-statistics" aria-labelledby="profile-statistics-title">
          <div class="profile-block__heading"><div><p class="section-kicker">ТЕКУЩИЙ СЕЗОН</p><h2 id="profile-statistics-title">Статистика игры</h2></div><NuxtLink class="text-action" to="/leaderboard">Сравнить в рейтинге <AppIcon name="arrow-right" :size="16" /></NuxtLink></div>
          <div class="profile-statistics__grid"><article><strong>{{ accountStore.user?.tableHandsPlayed || 0 }}</strong><span>раздач сыграно</span></article><article><strong>{{ tableWinRate }}%</strong><span>побед за столом</span></article><article><strong>{{ accountStore.user?.tableBestStreak || 0 }}</strong><span>лучшая серия</span></article><article><strong>{{ accountStore.user?.predictionCount || 0 }}</strong><span>прогнозов сделано</span></article><article><strong>{{ predictionSuccessRate }}%</strong><span>точных прогнозов</span></article><article><strong>{{ accountStore.user?.predictionSplitWins || 0 }}</strong><span>побед в делёжке</span></article></div>
          <p v-if="!(accountStore.user?.tableHandsPlayed || accountStore.user?.predictionCount)" class="profile-statistics__empty">Статистика начнёт заполняться после следующей завершённой раздачи или рассчитанного прогноза.</p>
        </section>
        <section v-if="season?.previous" class="profile-block season-card" aria-labelledby="season-card-title">
          <div class="profile-block__heading"><div><p class="section-kicker">ПРОШЛЫЙ СЕЗОН</p><h2 id="season-card-title">Итоги сезона {{ season.previous.seasonNumber }}</h2></div><NuxtLink class="text-action" to="/leaderboard">Сезон {{ season.season.number }} <AppIcon name="arrow-right" :size="16" /></NuxtLink></div>
          <div class="profile-statistics__grid"><article><strong>{{ formatSeasonValue(season.previous.snapshot.balance) }}</strong><span>итоговый баланс</span></article><article><strong>{{ formatSeasonValue(season.previous.snapshot.tableRating) }}</strong><span>рейтинг стола</span></article><article><strong>{{ formatSeasonValue(season.previous.snapshot.predictionRating) }}</strong><span>рейтинг прогнозов</span></article><article><strong>{{ formatSeasonValue(season.previous.snapshot.handsPlayed) }}</strong><span>раздач сыграно</span></article><article><strong>{{ formatSeasonValue(season.previous.snapshot.handsWon) }}</strong><span>раздач выиграно</span></article><article><strong>{{ formatSeasonValue(season.previous.snapshot.predictionCount) }}</strong><span>прогнозов сделано</span></article></div>
        </section>
      </section>

      <DailyBonus />

      <section class="profile-block premium-block" aria-labelledby="premium-block-title">
        <div class="premium-block__glow" />
        <div class="profile-block__heading"><div class="premium-block__title"><PremiumBadge :plan="premiumAccess?.active ? premiumAccess.plan : null" :size="46"/><div><p class="section-kicker">PREMIUM</p><h2 id="premium-block-title">{{ premiumAccess?.active ? `Premium ${premiumAccess.plan}` : 'Откройте свой стиль игры' }}</h2><p>{{ premiumAccess?.active ? 'Косметика и расширенные возможности уже доступны в аккаунте.' : 'Темы, рамки, аналитика и оформление профиля — без влияния на результат игр.' }}</p></div></div><span class="premium-block__badge">{{ premiumAccess?.active ? 'АКТИВЕН' : 'LITE · PRO · ELITE' }}</span></div>
        <NuxtLink class="btn premium-block__button" to="/premium">{{ premiumAccess?.active ? 'Настроить Premium' : 'Выбрать тариф' }} <AppIcon name="arrow-right" :size="17" /></NuxtLink>
      </section>

      <section class="profile-block achievements-panel" aria-labelledby="achievements-block-title">
        <button type="button" class="achievements-panel__toggle" :aria-expanded="achievementsOpen" @click="achievementsOpen = !achievementsOpen">
          <span><p class="section-kicker">ПРОГРЕСС</p><strong id="achievements-block-title">Достижения</strong><small>Выбирайте открытые значки для профиля</small></span>
          <span class="achievements-panel__count">{{ unlockedAchievements }}/{{ achievements.length }} {{ achievementsOpen ? '▲' : '▼' }}</span>
        </button>
        <p class="page-subtitle">Серые обычные достижения ещё не получены. Эксклюзивные сезонные появляются только после получения.</p>
        <div v-if="achievementsOpen && achievements.length" class="achievements-grid">
          <button v-for="achievement in sortedAchievements" :key="achievement.code" type="button" class="achievement-card" :class="{ 'achievement-card--locked': !achievement.unlocked, 'achievement-card--seasonal': achievement.seasonal, 'achievement-card--selected': accountStore.user?.selectedAchievementCode === achievement.code }" :disabled="!achievement.unlocked" @click="selectAchievement(accountStore.user?.selectedAchievementCode === achievement.code ? null : achievement.code)">
            <span class="achievement-card__icon"><AchievementBadge :code="achievement.code" :size="42"/></span><span><strong>{{ achievement.title }}</strong><small>{{ achievement.description }}</small><small v-if="achievement.seasonal">Сезон {{ achievement.seasonNumber }} · {{ achievement.rarity }}</small><small v-else>+{{ achievement.ratingReward }} рейтинга · +{{ achievement.moneyReward }} фишек</small></span>
          </button>
        </div>
        <p v-else-if="achievementsOpen" class="page-subtitle">Не удалось загрузить каталог. Обновите профиль.</p>
        <NuxtLink class="btn btn--ghost achievements-panel__link" to="/achievements">Открыть отдельной страницей</NuxtLink>
      </section>
      <section class="profile-block friends-block" aria-labelledby="friends-block-title">
        <header class="friends-header">
          <div class="friends-header__copy"><p class="section-kicker">СОЦИАЛЬНОЕ</p><h2 id="friends-block-title">Друзья</h2><p>Ваш круг игроков и быстрый доступ к совместным столам.</p></div>
          <div class="friends-header__stats"><span><strong>{{ friends.length }}</strong><small>друзей</small></span><span><strong>{{ incomingRequests.length }}</strong><small>входящих заявок</small></span></div>
        </header>

        <section class="friends-add" aria-labelledby="friends-add-title"><div class="friends-add__icon" aria-hidden="true">＋</div><div class="friends-add__copy"><h3 id="friends-add-title">Добавить игрока</h3><p>Введите точный ник, чтобы отправить заявку в друзья.</p></div><form class="friends-add__form" @submit.prevent="onSendFriendRequest"><input v-model="friendUsername" class="input" type="text" autocomplete="off" placeholder="Ник игрока" aria-label="Ник игрока"><button type="submit" class="btn" :disabled="loading || !friendUsername.trim()">Отправить заявку <AppIcon name="arrow-right" :size="17" /></button></form></section>

        <div v-if="initializing" class="friends-loading" role="status" aria-label="Загружаем друзей"><span /><span /><span /></div>
        <template v-else>
        <section class="friends-section" aria-labelledby="my-friends-title"><div class="friends-section__heading"><div><p class="section-kicker">МОЙ КРУГ</p><h3 id="my-friends-title">Мои друзья</h3></div><span v-if="friends.length" class="friends-section__count">{{ friends.length }}</span></div><ul v-if="friends.length" class="friends-list"><li v-for="item in friends" :key="item.friendshipId" class="friend-card"><div class="friend-card__identity"><span class="friend-avatar" aria-hidden="true">{{ item.friend.username.slice(0, 1).toUpperCase() }}</span><span class="friend-card__name"><strong>{{ item.friend.username }}</strong><small>{{ item.friend.balance.toLocaleString('ru-RU') }} фишек на балансе</small></span></div><details class="friend-card__actions"><summary>Действия</summary><div class="friend-transfer"><input v-model.number="transferAmounts[item.friend.id]" class="input" type="number" min="1" max="1000000" placeholder="Сумма" aria-label="Сумма перевода"><button type="button" class="btn" :disabled="loading || transferBusy === item.friend.id || !transferAmounts[item.friend.id]" @click="onTransfer(item.friend.id)">{{ transferBusy === item.friend.id ? 'Отправляем…' : 'Перевести фишки' }}</button><button type="button" class="btn btn--danger" :disabled="loading" @click="onDeleteFriend(item.friendshipId)">Удалить из друзей</button></div></details></li></ul><div v-else-if="!socialLoadError" class="friends-empty"><span class="friends-empty__icon" aria-hidden="true">♧</span><strong>Здесь пока тихо</strong><p>Добавьте первого игрока по нику — друзья появятся в этом списке.</p></div></section>

        <section class="friends-section friends-section--requests" aria-labelledby="incoming-friends-title"><div class="friends-section__heading"><div><p class="section-kicker">ОЖИДАЮТ ВАШЕГО РЕШЕНИЯ</p><h3 id="incoming-friends-title">Входящие заявки</h3></div><span v-if="incomingRequests.length" class="friends-section__count friends-section__count--accent">{{ incomingRequests.length }}</span></div><ul v-if="incomingRequests.length" class="friends-list"><li v-for="item in incomingRequests" :key="item.id" class="request-card"><div class="friend-card__identity"><span class="friend-avatar friend-avatar--request" aria-hidden="true">{{ item.fromUser.username.slice(0, 1).toUpperCase() }}</span><span class="friend-card__name"><strong>{{ item.fromUser.username }}</strong><small>Хочет добавить вас в друзья</small></span></div><div class="request-card__actions"><button type="button" class="btn btn--success" :disabled="loading" @click="onRespondRequest(item.id, 'accept')">Принять</button><button type="button" class="btn btn--danger" :disabled="loading" @click="onRespondRequest(item.id, 'reject')">Отклонить</button></div></li></ul><div v-else class="friends-empty friends-empty--compact"><span class="friends-empty__icon" aria-hidden="true">✓</span><strong>Новых заявок нет</strong><p>Когда кто-то отправит заявку, она появится здесь.</p></div></section>

        <section class="friends-section friends-section--outgoing" aria-labelledby="outgoing-friends-title"><div class="friends-section__heading"><div><p class="section-kicker">НА ПРОВЕРКЕ</p><h3 id="outgoing-friends-title">Исходящие заявки</h3></div><span v-if="outgoingRequests.length" class="friends-section__count">{{ outgoingRequests.length }}</span></div><ul v-if="outgoingRequests.length" class="friends-list friends-list--outgoing"><li v-for="item in outgoingRequests" :key="item.id" class="outgoing-card"><span class="friend-avatar friend-avatar--muted" aria-hidden="true">{{ item.toUser.username.slice(0, 1).toUpperCase() }}</span><span class="friend-card__name"><strong>{{ item.toUser.username }}</strong><small>Заявка отправлена</small></span><span class="outgoing-card__status" :class="`outgoing-card__status--${item.status}`">{{ item.status === 'pending' ? 'Ожидает' : item.status === 'accepted' ? 'Принята' : 'Отклонена' }}</span></li></ul><div v-else-if="!socialLoadError" class="friends-empty friends-empty--compact"><span class="friends-empty__icon" aria-hidden="true"><AppIcon name="arrow-right" :size="20"/></span><strong>Исходящих заявок нет</strong><p>Отправленные вами заявки будут отображаться здесь.</p></div></section>
        </template>
      </section>
      <section class="profile-block invites-block" aria-labelledby="invites-block-title">
        <div class="profile-block__heading"><div><p class="section-kicker">ЛОББИ</p><h2 id="invites-block-title">Приглашения в лобби</h2></div><span class="block-note">Ваши игры</span></div>
        <ul v-if="invites.length" class="profile-page__list">
          <li v-for="invite in invites" :key="invite.id" class="profile-page__invite-item">
            <div>
              <strong>{{ invite.roomName }}</strong>
              <p>Код: {{ invite.roomCode }} · От: {{ invite.fromUser.username }}</p>
            </div>
            <div v-if="invite.status === 'pending'" class="profile-page__actions">
              <button type="button" class="btn btn--success" :disabled="loading" @click="onRespondInvite(invite.id, 'accept')">Принять</button>
              <button type="button" class="btn btn--danger" :disabled="loading" @click="onRespondInvite(invite.id, 'decline')">Отклонить</button>
            </div>
            <span v-else class="tag">{{ invite.status }}</span>
          </li>
        </ul>

        <p v-else class="profile-page__muted">Приглашений пока нет.</p>
      </section>
      <section class="profile-block profile-footer-actions" aria-label="Настройки сессии">
        <div><p class="section-kicker">НАСТРОЙКИ</p><h2>Управление аккаунтом</h2><p>Системные настройки, Telegram и завершение сессии доступны в одном месте.</p></div>
        <div class="profile-page__actions"><NuxtLink class="btn btn--ghost" to="/settings">Открыть настройки</NuxtLink><NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink><button class="btn btn--danger" :disabled="loading" @click="logoutAccount">Выйти</button></div>
      </section>
      <WalletHistoryModal v-if="walletHistoryOpen" :history="walletHistory" :loading="walletHistoryLoading" @close="walletHistoryOpen = false" />
    </template>
  </main>
</template>

<style scoped lang="scss">
.profile-page {
  display: grid;
  gap: 0.9rem;
  padding-block: 1rem 2rem;

  &__panel {
    display: grid;
    gap: 0.6rem;

    h2,
    h3,
    p {
      margin: 0;
    }

    h2 {
      font-size: 1.1rem;
    }

    h3 {
      margin-top: 0.4rem;
      color: var(--text-muted);
      font-size: var(--text-sm);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
  }

  &__row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.5rem;
  }

  &__grid {
    display: grid;
    gap: 0.5rem;
  }

  &__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.45rem;

    li {
      display: flex;
      justify-content: space-between;
      gap: 0.6rem;
      align-items: center;
      padding: 0.5rem;
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.06);
    }
  }

  &__request-item,
  &__invite-item {
    align-items: flex-start !important;

    p {
      margin: 0.2rem 0 0;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
  }

  &__actions {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  &__muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__error,
  &__success {
    margin: 0;
    font-size: var(--text-sm);
  }

  &__error {
    color: var(--danger);
  }

  &__success {
    color: var(--success);
  }
}

@media (max-width: 760px) {
  .profile-page {
    &__row {
      grid-template-columns: 1fr;
    }

    &__list li {
      flex-direction: column;
      align-items: flex-start;
    }
  }
  .achievements-grid { grid-template-columns: 1fr; }
}

.profile-hero { padding: 1.5rem; border: 1px solid rgba(242,180,81,.22); border-radius: 28px; background: radial-gradient(circle at 90% -20%, rgba(242,180,81,.2), transparent 42%), linear-gradient(140deg, #173e2c, #0c2018 68%); box-shadow: 0 22px 60px rgba(0,0,0,.18); }
.profile-hero__top { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; }
.profile-hero__eyebrow { margin: 0 0 .45rem; color: var(--accent); font-size: .72rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
.profile-overview { display: grid; gap: .8rem; }
.identity-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 1rem; padding: 1rem; background: linear-gradient(115deg, rgba(23,55,40,.95), rgba(12,28,21,.96)); }
.identity-card__avatar { display: grid; place-items: center; width: 72px; height: 72px; border: 1px solid rgba(242,180,81,.38); border-radius: 22px; background: radial-gradient(circle at 35% 25%, rgba(242,180,81,.24), rgba(242,180,81,.06)); color: var(--accent); font-size: 2rem; font-weight: 900; }
.identity-card__name { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; h2 { margin: 0; font-size: 1.45rem; } span { padding: .25rem .48rem; border-radius: 999px; color: #172116; background: var(--accent); font-size: .65rem; font-weight: 900; text-transform: uppercase; } }
.identity-card__name span.is-elite { color: #fff6d7; background: linear-gradient(120deg, #7b4eb4, #d5a84d); }
.identity-card__name--gold h2 { color: #f1cd72; }.identity-card__name--mint h2 { color: #81ddb0; }.identity-card__name--violet h2 { color: #c69cff; }
.identity-card__actions { display: grid; justify-items: end; gap: .4rem; a { color: var(--accent); font-weight: 800; text-decoration: none; } }
.identity-card--frame-gold { border-color: rgba(242,180,81,.7); box-shadow: inset 0 0 0 1px rgba(242,180,81,.12), 0 15px 45px rgba(224,170,65,.12); }
.identity-card--frame-emerald { border-color: rgba(82,210,145,.6); box-shadow: inset 0 0 0 1px rgba(82,210,145,.12), 0 15px 45px rgba(42,173,109,.12); }
.identity-card--frame-obsidian { border-color: rgba(188,157,255,.42); box-shadow: inset 0 0 0 1px rgba(188,157,255,.08), 0 15px 45px rgba(83,48,135,.18); }
.identity-card--preset-royal { background: radial-gradient(circle at 10% 0, rgba(220,178,82,.22), transparent 32%), linear-gradient(115deg,#38294a,#111b18); }
.identity-card--preset-neon { background: radial-gradient(circle at 90% 15%, rgba(114,77,255,.25), transparent 36%), linear-gradient(115deg,#113d35,#13172e); }
.identity-card--animated { animation: premium-frame-pulse 3.2s ease-in-out infinite; }
@keyframes premium-frame-pulse { 50% { box-shadow: 0 0 0 1px rgba(242,180,81,.35), 0 16px 48px rgba(180,119,255,.22); } }
.identity-card__body p { margin: .25rem 0 0; color: var(--text-muted); }
.identity-card__phone { font-size: .8rem; }
.identity-card__admin { color: var(--accent); font-weight: 800; text-decoration: none; }
.profile-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: .65rem; }
.profile-metrics article,.profile-metric { position: relative; overflow: hidden; display: grid; gap: .18rem; padding: 1rem; border: 1px solid rgba(255,255,255,.09); border-radius: 18px; background: rgba(13,32,23,.82); color:var(--text-primary); text-align:left; &::after { content: ''; position: absolute; width: 75px; height: 75px; right: -35px; bottom: -40px; border-radius: 50%; background: rgba(242,180,81,.09); } small, span { color: var(--text-muted); } strong { color: var(--accent); font-size: clamp(1.35rem, 4vw, 2rem); } span { font-size: .72rem; } }
.profile-metric--button{cursor:pointer;font:inherit}.profile-metric--button:hover{border-color:rgba(242,180,81,.45)}
.table-record { display: flex; flex-wrap: wrap; gap: .35rem .65rem; }
.table-record b { font-weight: 800; }
.table-record__wins { color: #72d395 !important; }
.table-record__losses { color: #ff8b82 !important; }
.profile-page__transfer { display: flex; align-items: center; gap: .45rem; }
.profile-page__transfer .input { width: 120px; }
.profile-statistics { display: grid; gap: .9rem; background: linear-gradient(145deg, rgba(13,35,25,.96), rgba(10,25,19,.96)); }
.profile-statistics__heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; small { color: var(--accent); font-weight: 800; text-transform: uppercase; letter-spacing: .08em; } h2 { margin: .15rem 0 0; font-size: 1.2rem; } a { color: var(--accent); font-size: .8rem; font-weight: 800; text-decoration: none; } }
.profile-statistics__grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: .45rem; article { display: grid; gap: .2rem; padding: .75rem; border-radius: 14px; background: rgba(255,255,255,.045); } strong { color: var(--text-primary); font-size: 1.2rem; } span { color: var(--text-muted); font-size: .68rem; line-height: 1.25; } }
.profile-statistics__empty { margin: 0; padding: .65rem .75rem; border-radius: 12px; color: var(--text-muted); background: rgba(242,180,81,.07); font-size: .78rem; }
.username-card { display: grid; grid-template-columns: minmax(190px,.55fr) 1fr; align-items: center; gap: 1rem; strong, small { display: block; } small { margin-top: .2rem; color: var(--text-muted); } }
.achievements-panel { overflow: hidden; border-color: rgba(242,180,81,.16); }
.achievements-panel__heading { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.achievements-panel__toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .25rem 0; border: 0; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
.achievements-panel__toggle strong, .achievements-panel__toggle small { display: block; }
.achievements-panel__toggle strong { font-size: 1.2rem; }
.achievements-panel__toggle small { margin-top: .2rem; color: var(--text-muted); }
.achievements-panel__count { color: var(--accent); font-size: 1.4rem; font-weight: 900; }
.achievements-panel__link { margin-top: .75rem; }
.achievements-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: .55rem; }
.achievement-card { width: 100%; display: grid; grid-template-columns: 2.8rem minmax(0, 1fr); align-items: center; gap: .75rem; text-align: left; border: 1px solid rgba(255,255,255,.1); border-radius: var(--radius-md); padding: .75rem; background: rgba(255,255,255,.04); color: var(--text-primary); cursor: pointer; }
.achievement-card--selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.achievement-card:not(.achievement-card--locked) { border-color: rgba(242,180,81,.75); background: rgba(242,180,81,.10); }
.achievement-card--seasonal { border-color: rgba(190,130,255,.85) !important; background: linear-gradient(135deg, rgba(133,73,196,.25), rgba(255,255,255,.04)) !important; }
.telegram-card { display:grid; gap:1rem; border-color:rgba(67,181,129,.35); background:linear-gradient(135deg,rgba(25,91,63,.35),rgba(255,255,255,.03)); }
.telegram-card__connected { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.8rem 1rem; border-radius:var(--radius-md); color:var(--success); background:rgba(67,181,129,.12); }
.achievement-card--locked { filter: grayscale(1); opacity: .48; cursor: default; }
.achievement-card--selected { border-color: var(--success) !important; background: rgba(90,196,130,.16) !important; box-shadow: 0 0 0 1px var(--success); }
.achievement-card__icon { display: grid; place-items: center; width: 2.7rem; height: 2.7rem; border-radius: 13px; background: rgba(0,0,0,.2); font-size: 1.55rem; }
.achievement-card strong, .achievement-card small { display: block; }
.achievement-card small { color: var(--text-muted); margin-top: .2rem; font-size: .78rem; }
.profile-tabs { display: inline-flex; gap: .25rem; margin-top: .8rem; padding: .25rem; border-radius: 999px; background: rgba(255,255,255,.06); a { padding: .55rem .9rem; border-radius: 999px; color: var(--text-muted); text-decoration: none; } a.is-active { color: #142119; background: var(--accent); font-weight: 800; } }
@media (max-width: 760px) { .profile-hero { padding: 1.05rem; border-radius: 22px; } .profile-hero__top { display: grid; } .identity-card { grid-template-columns: auto 1fr; } .identity-card__actions { grid-column: 1 / -1; justify-items: start; } .profile-metrics { grid-template-columns: 1fr; } .profile-metrics article { grid-template-columns: 1fr auto; align-items: baseline; } .profile-metrics article span { grid-column: 1 / -1; } .profile-statistics__heading { align-items: flex-start; flex-direction: column; } .profile-statistics__grid { grid-template-columns: repeat(2, 1fr); } .username-card { grid-template-columns: 1fr; } .achievements-panel__toggle { align-items: flex-start; } .achievements-panel__count { flex: none; font-size: 1rem; } .achievement-card { grid-template-columns: 2.8rem minmax(0, 1fr); } }

/* Profile dashboard: presentation-only layer over the existing account actions. */
.profile-page { max-width: 1180px; gap: 1.1rem; }
.profile-hero { position: relative; overflow: hidden; padding: clamp(1.25rem, 3vw, 2.25rem); border: 1px solid rgba(242,180,81,.22); border-radius: 30px; background: radial-gradient(circle at 92% -30%, rgba(242,180,81,.24), transparent 36%), radial-gradient(circle at -5% 110%, rgba(50,177,128,.18), transparent 40%), linear-gradient(135deg, #173f2d 0%, #0c2018 66%, #091610 100%); box-shadow: 0 24px 80px rgba(0,0,0,.22), inset 0 1px rgba(255,255,255,.07); }
.profile-hero::after { content: ''; position: absolute; inset: auto -8% -70% 42%; height: 180px; border: 1px solid rgba(242,180,81,.14); border-radius: 50%; transform: rotate(-9deg); pointer-events: none; }
.profile-hero__top { position: relative; z-index: 1; }
.profile-hero__signals { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: .55rem; margin-top: 1.35rem; }
.profile-hero__signals span { display: inline-flex; align-items: center; gap: .45rem; padding: .45rem .7rem; border: 1px solid rgba(255,255,255,.1); border-radius: 999px; color: var(--text-muted); background: rgba(0,0,0,.14); font-size: .72rem; font-weight: 700; }
.profile-signal__dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px rgba(242,180,81,.12); }.profile-signal__dot--live { background: #72d395; box-shadow: 0 0 0 4px rgba(114,211,149,.12); }
.profile-dashboard { display: grid; gap: 1rem; }
.profile-top-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, .65fr); gap: 1rem; }
.identity-card { min-width: 0; min-height: 0; padding: clamp(.8rem, 1.8vw, 1.15rem); border-color: rgba(242,180,81,.18); border-radius: 24px; background: radial-gradient(circle at 0 0, rgba(242,180,81,.12), transparent 35%), linear-gradient(135deg, rgba(24,64,45,.98), rgba(10,27,20,.98)); box-shadow: 0 18px 48px rgba(0,0,0,.17), inset 0 1px rgba(255,255,255,.06); }
.identity-card__avatar { width: 68px; height: 68px; border-radius: 20px; box-shadow: 0 12px 30px rgba(242,180,81,.12), inset 0 1px rgba(255,255,255,.13); }
.identity-card__body { min-width: 0; }.identity-card__name h2 { max-width: 100%; overflow-wrap: anywhere; font-size: clamp(1.2rem, 2.7vw, 1.65rem); }.identity-card__body p { overflow-wrap: anywhere; }.identity-card__phone { font-size: .75rem; }
.identity-card__actions { align-self: stretch; }.text-action { display: inline-flex; align-items: center; gap: .4rem; color: var(--accent); font-size: .78rem; font-weight: 800; text-decoration: none; transition: color .18s ease, transform .18s ease; }.text-action span { transition: transform .18s ease; }.text-action:hover { color: #fff0bf; transform: translateY(-1px); }.text-action:hover span { transform: translateX(3px); }
.balance-card { position: relative; overflow: hidden; display: grid; gap: 1rem; min-height: 190px; padding: clamp(1rem, 2.4vw, 1.5rem); border: 1px solid rgba(242,180,81,.34); border-radius: 24px; background: radial-gradient(circle at 100% 0, rgba(242,180,81,.22), transparent 44%), linear-gradient(145deg, #263e2c, #101f18); box-shadow: 0 18px 48px rgba(0,0,0,.17), inset 0 1px rgba(255,255,255,.07); }.balance-card::after { content: ''; position: absolute; right: -45px; bottom: -70px; width: 170px; height: 170px; border: 1px solid rgba(242,180,81,.16); border-radius: 50%; box-shadow: 0 0 0 18px rgba(242,180,81,.035), 0 0 0 36px rgba(242,180,81,.025); pointer-events: none; }
.balance-card__heading,.balance-card__actions { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: .75rem; }.balance-card__heading h2 { margin: .15rem 0 0; font-size: 1.05rem; }.balance-card__coin { display: grid; place-items: center; width: 2.3rem; height: 2.3rem; border: 1px solid rgba(242,180,81,.38); border-radius: 50%; color: var(--accent); background: rgba(242,180,81,.12); font-size: 1.2rem; }
.balance-card__amount { position: relative; z-index: 1; display: grid; gap: .15rem; padding: 0; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }.balance-card__amount strong { color: #fff3c9; font: 800 clamp(2rem, 4vw, 2.85rem) 'Space Grotesk', sans-serif; letter-spacing: -.04em; }.balance-card__amount span { color: var(--text-muted); font-size: .72rem; }
.balance-card__actions { justify-content: flex-start; flex-wrap: wrap; margin-top: auto; }.balance-card__primary { min-height: 40px; padding: .6rem .85rem; font-size: .78rem; }.balance-card__primary span { font-size: 1.15rem; line-height: .7; }.balance-card__history { color: var(--text-primary); font-size: .75rem; font-weight: 800; text-decoration: none; opacity: .78; }.balance-card__history span { color: var(--accent); margin-left: .2rem; }
.profile-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }.profile-metrics article { display: flex; align-items: center; gap: .75rem; min-width: 0; padding: 1rem; border-color: rgba(255,255,255,.1); border-radius: 20px; background: linear-gradient(135deg, rgba(20,49,36,.95), rgba(11,27,20,.92)); transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }.profile-metrics article:hover { transform: translateY(-2px); border-color: rgba(242,180,81,.32); box-shadow: 0 12px 28px rgba(0,0,0,.16); }.profile-metrics article > div { display: grid; gap: .18rem; min-width: 0; }.profile-metrics article small { color: var(--text-muted); font-size: .68rem; }.profile-metrics article strong { font-size: clamp(1.3rem, 3vw, 1.8rem); }.profile-metrics article strong i { color: var(--text-muted); font-size: .8rem; font-style: normal; }.profile-metrics article > div > span:not(.table-record) { overflow-wrap: anywhere; }.metric-icon { display: grid; flex: 0 0 auto; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 14px; color: #172116; background: var(--accent); font-size: 1.25rem; box-shadow: 0 8px 20px rgba(242,180,81,.18); }.metric-icon--violet { color: #fff; background: linear-gradient(135deg, #8c65d8, #49327d); box-shadow: 0 8px 20px rgba(140,101,216,.2); }.metric-icon--green { color: #0e281b; background: #72d395; box-shadow: 0 8px 20px rgba(114,211,149,.17); }
.profile-block { position: relative; display: grid; gap: 1rem; padding: clamp(1rem, 2.4vw, 1.45rem); border: 1px solid rgba(255,255,255,.09); border-radius: 24px; background: linear-gradient(145deg, rgba(15,37,27,.97), rgba(9,24,17,.97)); box-shadow: 0 14px 42px rgba(0,0,0,.12), inset 0 1px rgba(255,255,255,.045); }.profile-block__heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; }.profile-block__heading h2 { margin: .12rem 0 0; font-size: clamp(1.08rem, 2vw, 1.35rem); }.profile-block__heading > div > p:last-child:not(.section-kicker) { margin: .35rem 0 0; color: var(--text-muted); font-size: .8rem; }.section-kicker { margin: 0; color: var(--accent); font-size: .64rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }.block-note { color: var(--text-muted); font-size: .72rem; }
.profile-statistics { background: linear-gradient(145deg, rgba(16,42,29,.98), rgba(10,26,19,.98)); }.profile-statistics__grid { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: .55rem; }.profile-statistics__grid article { min-width: 0; padding: .8rem; border: 1px solid rgba(255,255,255,.06); background: rgba(255,255,255,.035); }.profile-statistics__grid strong { font-size: 1.18rem; overflow-wrap: anywhere; }.profile-statistics__grid span { overflow-wrap: anywhere; }.profile-statistics__empty { margin: 0; }
.profile-block--account { gap: 1.1rem; }.account-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }.username-card,.phone-verification,.account-status { min-width: 0; padding: 1rem; border: 1px solid rgba(255,255,255,.08); border-radius: 18px; background: rgba(255,255,255,.035); }.username-card { display: grid; gap: .8rem; }.username-card strong,.username-card small { display: block; }.username-card small { margin-top: .25rem; color: var(--text-muted); font-size: .76rem; }.phone-verification h3 { margin: 0 0 .7rem; font-size: .95rem; }.account-status { display: flex; align-items: center; gap: .75rem; }.account-status__icon { display: grid; flex: 0 0 auto; place-items: center; width: 2.2rem; height: 2.2rem; border-radius: 50%; color: #102118; background: #72d395; font-weight: 900; }.account-status div { display: grid; gap: .18rem; min-width: 0; }.account-status small { color: var(--text-muted); }.account-status .text-action { margin-left: auto; }
.premium-block { overflow: hidden; isolation: isolate; grid-template-columns: 1fr auto; align-items: center; border-color: rgba(196,156,255,.26); background: radial-gradient(circle at 90% 0, rgba(181,119,255,.22), transparent 42%), linear-gradient(135deg, rgba(37,31,60,.97), rgba(13,27,23,.98)); }.premium-block__glow { position: absolute; z-index: -1; right: 9%; bottom: -80px; width: 220px; height: 160px; border-radius: 50%; background: rgba(178,112,255,.12); filter: blur(25px); }.premium-block__badge { align-self: start; padding: .45rem .65rem; border: 1px solid rgba(216,185,255,.32); border-radius: 999px; color: #e2caff; background: rgba(188,133,255,.12); font-size: .62rem; font-weight: 900; letter-spacing: .1em; white-space: nowrap; }.premium-block__button { grid-column: 2; grid-row: 1; background: linear-gradient(135deg, #b98bff, #7b55c1); box-shadow: 0 12px 28px rgba(125,82,193,.25); }.premium-block__button span { margin-left: .4rem; }.premium-block__button:hover { filter: brightness(1.08); transform: translateY(-1px); }
.premium-block__title { display: flex; align-items: center; gap: .8rem; min-width: 0; }.premium-block__title > div { min-width: 0; }
.achievements-panel { gap: .7rem; border-color: rgba(242,180,81,.16); }.achievements-panel__toggle { padding: 0; }.achievements-panel__toggle strong { margin-top: .15rem; font-size: 1.28rem; }.achievements-panel__count { padding: .25rem .55rem; border: 1px solid rgba(242,180,81,.24); border-radius: 999px; background: rgba(242,180,81,.08); font-size: .9rem; }.achievements-panel__link { justify-self: start; margin-top: .25rem; }.achievements-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.friends-block .profile-page__list,.invites-block .profile-page__list { max-height: 430px; overflow: auto; padding-right: .15rem; }.friends-block .profile-page__list li,.invites-block .profile-page__list li { padding: .75rem; border: 1px solid rgba(255,255,255,.06); border-radius: 16px; background: rgba(255,255,255,.035); }.friends-block h3 { margin-top: .35rem; }.profile-footer-actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }.profile-footer-actions h2 { margin: .15rem 0 0; font-size: 1.1rem; }.profile-footer-actions p:last-child { margin: .35rem 0 0; color: var(--text-muted); font-size: .78rem; }.profile-footer-actions .profile-page__actions { flex: 0 0 auto; }
@media (max-width: 900px) { .profile-top-grid { grid-template-columns: 1fr; }.profile-statistics__grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 620px) { .profile-page { gap: .8rem; padding-inline: .7rem; }.profile-hero { padding: 1rem; border-radius: 23px; }.profile-hero__top { gap: .7rem; }.profile-tabs { width: 100%; margin-top: .35rem; }.profile-tabs a { flex: 1; text-align: center; }.profile-hero__signals { margin-top: 1rem; }.profile-hero__signals span { font-size: .65rem; }.profile-top-grid { gap: .8rem; }.identity-card { grid-template-columns: auto minmax(0, 1fr); gap: .75rem; min-height: 0; }.identity-card__avatar { width: 64px; height: 64px; border-radius: 19px; font-size: 1.6rem; }.identity-card__actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-items: start; padding-top: .25rem; border-top: 1px solid rgba(255,255,255,.08); }.balance-card { min-height: 0; }.balance-card__actions { align-items: stretch; }.balance-card__primary { flex: 1 1 180px; }.profile-metrics { grid-template-columns: 1fr; gap: .55rem; }.profile-metrics article { padding: .8rem; }.profile-statistics__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.profile-block__heading { align-items: flex-start; }.account-settings-grid { grid-template-columns: 1fr; }.premium-block { grid-template-columns: 1fr; gap: .85rem; }.premium-block__button { grid-column: 1; grid-row: auto; justify-self: start; }.premium-block__badge { position: absolute; top: 1rem; right: 1rem; max-width: 42%; overflow: hidden; text-overflow: ellipsis; }.achievements-grid { grid-template-columns: 1fr; }.profile-footer-actions { display: grid; }.profile-footer-actions .profile-page__actions { width: 100%; }.profile-footer-actions .btn { flex: 1; } }
@media (max-width: 390px) { .profile-page { padding-inline: .5rem; }.profile-hero__signals { display: grid; }.profile-hero__signals span { justify-content: center; }.identity-card__name { gap: .3rem; }.identity-card__name h2 { font-size: 1.05rem; }.identity-card__name span { font-size: .56rem; }.identity-card__body p:not(.identity-card__phone) { font-size: .75rem; }.balance-card__amount strong { font-size: 2rem; }.profile-block { padding: .9rem; border-radius: 20px; }.profile-page__row .btn { width: 100%; }.profile-page__transfer { width: 100%; }.profile-page__transfer .input { width: 100%; }.profile-page__transfer .btn { flex: 1; }.account-status { align-items: flex-start; flex-wrap: wrap; }.account-status .text-action { width: 100%; margin: .25rem 0 0 3rem; } }
.friends-block { gap: 1.25rem; }
.friends-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; padding-bottom: .2rem; }
.friends-header h2 { margin: .2rem 0 .35rem; font-size: clamp(1.55rem, 3vw, 2rem); }
.friends-header__copy p:last-child { margin: 0; color: var(--text-muted); font-size: .8rem; }
.friends-header__stats { display: flex; gap: .55rem; }
.friends-header__stats span { display: grid; min-width: 104px; padding: .65rem .75rem; border: 1px solid rgba(255,255,255,.08); border-radius: 15px; background: rgba(255,255,255,.035); }
.friends-header__stats strong { font-size: 1.25rem; color: var(--accent); }
.friends-header__stats small { color: var(--text-muted); font-size: .68rem; }
.friends-add { display: grid; grid-template-columns: auto minmax(160px, .8fr) minmax(280px, 1.2fr); align-items: center; gap: .8rem; padding: 1rem; border: 1px solid rgba(242,180,81,.2); border-radius: 20px; background: linear-gradient(135deg, rgba(242,180,81,.1), rgba(255,255,255,.035)); }
.friends-add__icon { display: grid; place-items: center; width: 2.8rem; height: 2.8rem; border-radius: 15px; color: #17251c; background: var(--accent); font-size: 1.55rem; }
.friends-add__copy h3 { margin: 0; font-size: 1rem; }.friends-add__copy p { margin: .25rem 0 0; color: var(--text-muted); font-size: .75rem; }
.friends-add__form { display: flex; gap: .55rem; }.friends-add__form .input { min-width: 0; flex: 1; }.friends-add__form .btn { white-space: nowrap; }.friends-add__form .btn span { margin-left: .35rem; }
.friends-section { display: grid; gap: .65rem; }.friends-section--requests { padding-top: .25rem; }.friends-section--outgoing { padding-top: .1rem; }
.friends-section__heading { display: flex; align-items: center; justify-content: space-between; gap: .8rem; }.friends-section__heading h3 { margin: .15rem 0 0; font-size: 1.05rem; }.friends-section__count { display: grid; place-items: center; min-width: 1.65rem; height: 1.65rem; padding-inline: .35rem; border-radius: 999px; color: var(--text-muted); background: rgba(255,255,255,.08); font-size: .75rem; font-weight: 800; }.friends-section__count--accent { color: #182419; background: var(--accent); }
.friends-list { display: grid; gap: .55rem; margin: 0; padding: 0; list-style: none; }.friend-card,.request-card,.outgoing-card { min-width: 0; border: 1px solid rgba(255,255,255,.08); border-radius: 17px; background: rgba(255,255,255,.035); transition: border-color .2s ease, transform .2s ease, background .2s ease; }.friend-card:hover,.request-card:hover,.outgoing-card:hover { border-color: rgba(242,180,81,.28); background: rgba(255,255,255,.055); transform: translateY(-1px); }
.friend-card { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .7rem .8rem; }.friend-card__identity { display: flex; align-items: center; min-width: 0; gap: .7rem; }.friend-avatar { display: grid; flex: 0 0 auto; place-items: center; width: 2.55rem; height: 2.55rem; border: 1px solid rgba(242,180,81,.28); border-radius: 13px; color: #f5d989; background: linear-gradient(145deg, #2c5a45, #142d22); font-weight: 900; }.friend-avatar--request { color: #d7c0ff; border-color: rgba(190,145,255,.3); background: linear-gradient(145deg, #483b68, #241e3a); }.friend-avatar--muted { color: var(--text-muted); border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.07); }
.friend-card__name { display: grid; min-width: 0; gap: .18rem; }.friend-card__name strong { overflow-wrap: anywhere; }.friend-card__name small { color: var(--text-muted); font-size: .72rem; overflow-wrap: anywhere; }.friend-card__actions summary { color: var(--accent); font-size: .75rem; font-weight: 800; cursor: pointer; list-style: none; }.friend-card__actions summary::-webkit-details-marker { display: none; }.friend-card__actions summary::after { content: '⌄'; margin-left: .35rem; }.friend-card__actions[open] summary::after { content: '⌃'; }.friend-transfer { display: flex; gap: .45rem; margin-top: .55rem; }.friend-transfer .input { width: 110px; }.friend-transfer .btn { white-space: nowrap; }
.request-card { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding: .7rem .8rem; }.request-card__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .4rem; }.request-card__actions .btn { padding: .55rem .7rem; font-size: .75rem; }.outgoing-card { display: flex; align-items: center; gap: .7rem; padding: .7rem .8rem; }.outgoing-card .friend-card__name { flex: 1; }.outgoing-card__status { padding: .3rem .55rem; border-radius: 999px; font-size: .68rem; font-weight: 800; color: #e6c681; background: rgba(181,134,53,.15); }.outgoing-card__status--accepted { color: #9be6b3; background: rgba(61,157,97,.15); }.outgoing-card__status--rejected { color: #ffaaa7; background: rgba(188,78,87,.15); }
.friends-empty { display: grid; justify-items: center; gap: .35rem; padding: 1.6rem 1rem; border: 1px dashed rgba(255,255,255,.12); border-radius: 17px; background: rgba(255,255,255,.025); text-align: center; }.friends-empty__icon { color: var(--accent); font-size: 1.8rem; }.friends-empty strong { font-size: .95rem; }.friends-empty p { max-width: 360px; margin: 0; color: var(--text-muted); font-size: .75rem; line-height: 1.45; }.friends-empty--compact { padding-block: 1.15rem; }.friends-empty--compact .friends-empty__icon { font-size: 1.4rem; }
.friends-loading { display: grid; gap: .55rem; }.friends-loading span { height: 66px; border-radius: 17px; background: linear-gradient(90deg, rgba(255,255,255,.04) 20%, rgba(255,255,255,.1) 50%, rgba(255,255,255,.04) 80%); background-size: 200% 100%; animation: friends-shimmer 1.6s ease-in-out infinite; }.friends-loading span:nth-child(2) { animation-delay: .12s; }.friends-loading span:nth-child(3) { animation-delay: .24s; }
@keyframes friends-shimmer { to { background-position-x: -200%; } }
@media (prefers-reduced-motion: reduce) { .friends-loading span { animation: none; } }
.balance-card__amount strong { overflow-wrap: anywhere; }
@media (max-width: 760px) { .friends-header { align-items: stretch; flex-direction: column; }.friends-header__stats { width: 100%; }.friends-header__stats span { flex: 1; }.friends-add { grid-template-columns: auto minmax(0, 1fr); }.friends-add__form { grid-column: 1 / -1; }.friends-add__form .btn { flex: 0 0 auto; } }
@media (max-width: 480px) { .friends-add { grid-template-columns: auto minmax(0, 1fr); padding: .8rem; }.friends-add__icon { width: 2.35rem; height: 2.35rem; }.friends-add__copy p { font-size: .7rem; }.friends-add__form { display: grid; grid-template-columns: 1fr; }.friends-add__form .btn { width: 100%; }.friend-card,.request-card,.outgoing-card { align-items: flex-start; }.friend-card { flex-direction: column; }.friend-card__actions { width: 100%; padding-top: .55rem; border-top: 1px solid rgba(255,255,255,.07); }.friend-card__actions summary { display: inline-block; }.friend-transfer { display: grid; grid-template-columns: 1fr auto; }.friend-transfer .input { width: auto; min-width: 0; }.request-card { flex-direction: column; }.request-card__actions { width: 100%; justify-content: stretch; }.request-card__actions .btn { flex: 1; }.outgoing-card { flex-wrap: wrap; }.outgoing-card__status { margin-left: auto; } }
</style>
