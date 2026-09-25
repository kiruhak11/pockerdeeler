<script setup lang="ts">
import { useGameStore } from '~/stores/game'
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import ReservedRooms from '~/components/room/ReservedRooms.vue'
import AppIcon from '~/components/ui/AppIcon.vue'

const gameStore = useGameStore()
const accountStore = useAccountStore()
const { loadMe, logout } = useAccountAuth()

const roomCode = ref('')
const authError = ref('')
const authLoading = ref(false)
const roomLookupError = ref('')

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }

  accountStore.loadSession()
  loadMe().catch((error) => {
    authError.value = getHttpErrorMessage(error, 'Не удалось обновить аккаунт. Проверьте соединение.')
  })
})

const hasSaved = computed(() => gameStore.canContinue)

async function startNewLocalGame() {
  gameStore.resetGame()
  await navigateTo('/setup')
}

async function continueLocalGame() {
  gameStore.loadFromLocalStorage()
  if (!gameStore.game) {
    gameStore.pushToast('Сохраненной игры не найдено.')
    return
  }

  await navigateTo('/game')
}

async function joinByCode() {
  const code = roomCode.value.trim().toUpperCase()
  roomLookupError.value = ''
  if (!code) return
  try {
    const result = await $fetch<{ type: 'HOME' | 'ONLINE' | 'NOT_FOUND'; code: string }>(`/api/rooms/resolve?code=${encodeURIComponent(code)}`, { retry: 0 })
    if (result.type === 'HOME') return await navigateTo(`/room/${result.code}/join`)
    if (result.type === 'ONLINE') return await navigateTo(`/online/${result.code}`)
    roomLookupError.value = 'Стол с таким кодом не найден.'
  } catch (error) {
    roomLookupError.value = getHttpErrorMessage(error, 'Не удалось проверить код стола. Попробуйте ещё раз.')
  }
}

async function logoutAccount() {
  if (authLoading.value) return
  authLoading.value = true
  authError.value = ''
  try { await logout() }
  catch (error) { authError.value = getHttpErrorMessage(error, 'Не удалось выйти. Повторите при восстановлении сети.') }
  finally { authLoading.value = false }
}
</script>

<template>
  <main class="page-shell home-page">
    <section class="home-page__hero">
      <div class="home-page__copy"><p class="eyebrow">Живой покер. Цифровые фишки.</p><h1>Весь стол<br><em>в одном касании</em></h1><p>Играйте в покер онлайн с друзьями или откройте домашний стол с настоящими картами.</p><div class="home-page__primary-actions"><NuxtLink class="btn" to="/rooms">Играть онлайн</NuxtLink><NuxtLink class="home-page__secondary-link" to="/online/create">Создать онлайн-комнату</NuxtLink></div></div>
      <aside v-if="accountStore.user" class="home-page__identity"><span>{{ accountStore.user.selectedAchievementCode ? '♠' : accountStore.user.username.slice(0, 1).toUpperCase() }}</span><div><small>Вы вошли как</small><strong>{{ accountStore.user.username }}</strong><b>{{ accountStore.user.balance.toLocaleString('ru-RU') }} фишек</b></div><NuxtLink to="/profile">Профиль</NuxtLink></aside>
    </section>

    <ReservedRooms />

    <section class="panel home-page__join">
      <div><span class="home-page__number">01</span><p class="eyebrow">Быстрый вход</p><h2>Введите код стола</h2></div>
      <div class="home-page__join-row"><input v-model="roomCode" class="input" type="text" inputmode="text" maxlength="8" autocomplete="off" placeholder="A7K2M9" @keyup.enter="joinByCode"><button type="button" class="btn" @click="joinByCode">Войти за стол</button></div>
      <p v-if="roomLookupError" class="home-page__error" role="alert">{{ roomLookupError }}</p>
      <NuxtLink class="home-page__text-link" to="/rooms">Посмотреть все открытые столы <AppIcon name="arrow-right" :size="16" /></NuxtLink>
    </section>

    <section class="home-page__choices">
      <NuxtLink class="home-choice home-choice--online" to="/online/create"><span>02</span><div><small>Для друзей онлайн</small><h2>Создать онлайн-стол</h2><p>Откройте цифровый стол и пригласите игроков по коду.</p></div><b>＋</b></NuxtLink>
      <NuxtLink class="home-choice home-choice--accent" to="/create"><span>03</span><div><small>Для организатора</small><h2>Домашняя игра</h2><p>Настройте блайнды, бай-ин и играйте настоящими картами.</p></div><b>＋</b></NuxtLink>
      <button class="home-choice" type="button" @click="startNewLocalGame"><span>04</span><div><small>Без интернета</small><h2>Локальная игра</h2><p>Калькулятор дилера на одном устройстве.</p></div><AppIcon name="arrow-right" :size="20" /></button>
    </section>

    <button v-if="hasSaved" type="button" class="home-page__continue" @click="continueLocalGame"><span>Сохранённая локальная игра</span><strong>Продолжить <AppIcon name="arrow-right" :size="17" /></strong></button>

    <section v-if="!accountStore.user" class="home-page__account"><div><strong>Сохраните прогресс</strong><p>Аккаунт хранит баланс, рейтинг, друзей и достижения.</p></div><NuxtLink class="btn btn--ghost" to="/login">Войти</NuxtLink><NuxtLink class="btn" to="/login?mode=register">Создать аккаунт</NuxtLink></section>
    <section v-else class="home-page__session"><button type="button" :disabled="authLoading" @click="logoutAccount">Выйти из аккаунта</button></section>
    <p v-if="authError" class="home-page__error" role="alert">{{ authError }}</p>
  </main>
</template>

<style scoped lang="scss">
.home-page { display: grid; gap: 1rem; max-width: 980px; padding-top: clamp(1.5rem, 5vw, 4.5rem); }
.home-page__hero { display: grid; grid-template-columns: 1fr auto; gap: 2rem; align-items: end; padding: clamp(.5rem, 3vw, 2rem) 0; }
.home-page__copy h1 { margin: .35rem 0 .8rem; font: 700 clamp(2.7rem, 8vw, 5.8rem)/.9 'Space Grotesk', sans-serif; letter-spacing: -.07em; max-width: 760px; }
.home-page__copy h1 em { color: var(--accent); font-style: normal; }
.home-page__copy > p:last-child { max-width: 620px; margin: 0; color: var(--text-muted); font-size: clamp(1rem, 2vw, 1.2rem); }
.home-page__primary-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; margin-top: 1.2rem; }
.home-page__secondary-link { color: var(--text-muted); font-size: .9rem; }
.home-page__identity { display: grid; grid-template-columns: auto 1fr; gap: .7rem; min-width: 210px; padding: .8rem; border: 1px solid #ffffff14; border-radius: 18px; background: #101f18b8; > span { grid-row: 1 / 3; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; color: #142119; background: var(--accent); font-weight: 900; } small, strong, b { display: block; } small { color: var(--text-muted); } b { color: var(--accent); font-size: .78rem; } a { grid-column: 2; color: var(--text-muted); font-size: .8rem; } }
.home-page__join { position: relative; display: grid; grid-template-columns: minmax(170px, .7fr) 1fr; gap: 1rem 1.5rem; overflow: hidden; padding: 1.35rem; border-color: rgba(242,180,81,.4); background: linear-gradient(120deg, rgba(43,75,55,.96), rgba(16,31,24,.97)); h2 { margin: .2rem 0 0; font-size: 1.45rem; } .eyebrow { margin: 0; } }
.home-page__number { position: absolute; right: 1rem; top: -.7rem; color: #ffffff08; font: 800 6rem 'Space Grotesk'; }
.home-page__join-row { align-self: center; display: grid; grid-template-columns: 1fr auto; gap: .6rem; .input { min-height: 54px; text-transform: uppercase; letter-spacing: .18em; font: 700 1.1rem 'Space Grotesk'; } }
.home-page__text-link { grid-column: 2; color: var(--text-muted); font-size: .85rem; }
.home-page__choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.home-choice { display: grid; grid-template-columns: auto 1fr auto; gap: 1rem; align-items: center; min-height: 150px; padding: 1.2rem; border: 1px solid #ffffff14; border-radius: var(--radius-lg); color: inherit; background: linear-gradient(145deg, #1a2822, #101b16); text-align: left; text-decoration: none; cursor: pointer; > span { align-self: start; color: var(--text-muted); font: 700 .75rem 'Space Grotesk'; } small { color: var(--accent); text-transform: uppercase; letter-spacing: .08em; } h2 { margin: .2rem 0; } p { margin: 0; color: var(--text-muted); } > b { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: #ffffff0d; font-size: 1.4rem; } &--accent { background: linear-gradient(145deg, #3b4328, #163326); border-color: rgba(242,180,81,.28); } }
.home-choice--online { border-color: rgba(102, 190, 255, .35); background: linear-gradient(145deg, #183f4e, #102a31); }
.home-page__continue, .home-page__account { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .9rem 1.1rem; border: 1px dashed rgba(242,180,81,.35); border-radius: var(--radius-md); color: inherit; background: transparent; }
.home-page__continue { cursor: pointer; strong { color: var(--accent); } }
.home-page__account { border-style: solid; background: #ffffff05; p { margin: .2rem 0 0; color: var(--text-muted); } }
.home-page__session { text-align: right; button { border: 0; color: var(--text-muted); background: none; text-decoration: underline; cursor: pointer; } }
.home-page__error { color: var(--danger); }
@media (max-width: 900px) { .home-page__choices { grid-template-columns: 1fr 1fr; } }
@media (max-width: 700px) { .home-page { padding-top: 1rem; } .home-page__hero { grid-template-columns: 1fr; gap: 1rem; } .home-page__copy h1 { font-size: clamp(2.7rem, 14vw, 4.2rem); } .home-page__identity { grid-template-columns: auto 1fr auto; min-width: 0; } .home-page__identity a { grid-column: 3; grid-row: 1 / 3; align-self: center; } .home-page__join, .home-page__choices { grid-template-columns: 1fr; } .home-page__join-row { grid-template-columns: 1fr; } .home-page__text-link { grid-column: 1; } .home-page__primary-actions { display: grid; grid-template-columns: 1fr; } .home-page__primary-actions .btn { width: 100%; } .home-choice { min-height: 128px; padding: 1rem; } .home-page__account { align-items: stretch; flex-direction: column; } }
</style>
