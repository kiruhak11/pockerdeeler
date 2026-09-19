<script setup lang="ts">
import { usePlayerSessionStore } from "~/stores/playerSession"
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import ReservedRooms from '~/components/room/ReservedRooms.vue'
import { createClientRequestId } from '~/utils/idempotency'
const route = useRoute()
const sessionStore = usePlayerSessionStore()
const accountStore = useAccountStore()
const { loadMe } = useAccountAuth()

const code = computed(() => String(route.params.code || '').toUpperCase())
const name = ref('')
const password = ref('')
const lobby = ref<{
  name: string
  status: string
  hasPassword: boolean
  playerPolicy: 'mixed' | 'accounts' | 'guests'
  allowSpectators: boolean
  buyInEnabled: boolean
  minBuyIn: number
  maxBuyIn: number
  predictionsEnabled: boolean
} | null>(null)
const asSpectator = ref(false)
const useAccount = ref(true)
const isLoading = ref(false)
const errorMessage = ref('')
const buyInAmount = ref(5000)
const allowedBuyInMax = computed(() => Math.min(lobby.value?.maxBuyIn || 0, accountStore.user?.balance || 0))
const canAffordBuyIn = computed(() => !lobby.value?.buyInEnabled || allowedBuyInMax.value >= lobby.value.minBuyIn)
const buyInPresets = computed(() => {
  if (!lobby.value || allowedBuyInMax.value < lobby.value.minBuyIn) return []
  const middle = Math.floor((lobby.value.minBuyIn + allowedBuyInMax.value) / 2)
  return [...new Set([lobby.value.minBuyIn, middle, allowedBuyInMax.value])]
})
const accessNotice = computed(() => route.query.reason === 'kicked' ? 'Дилер удалил вас из комнаты. Можно войти снова.' : '')

const { joinRoom } = usePlayerRoom(code)

onMounted(async () => {
  accountStore.loadSession()
  if (accountStore.token) {
    await loadMe().catch(() => accountStore.clearSession())
  }

  if (accountStore.user && !name.value) {
    name.value = accountStore.user.username
  }

  try {
    lobby.value = await $fetch<NonNullable<typeof lobby.value>>(`/api/rooms/${code.value}/info`)
    if (lobby.value?.playerPolicy === 'guests') useAccount.value = false
    buyInAmount.value = Math.min(lobby.value.maxBuyIn, Math.max(lobby.value.minBuyIn, accountStore.user?.balance || lobby.value.minBuyIn))
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Комната не найдена')
  }
})

async function submit() {
  isLoading.value = true
  errorMessage.value = ''

  try {
    const response = await joinRoom({
      name: name.value,
      password: password.value || undefined,
      role: asSpectator.value ? 'spectator' : 'player',
      authToken: useAccount.value ? (accountStore.token || undefined) : undefined,
      buyInAmount: !asSpectator.value && useAccount.value && lobby.value?.buyInEnabled ? buyInAmount.value : undefined,
      clientRequestId: createClientRequestId('join')
    }) as {
      roomCode: string
      playerId?: string
      participantId: string
      playerSessionToken: string
      playerUrl: string
      memberState?: string
    }

    sessionStore.saveSession({
      roomCode: response.roomCode,
      playerId: response.playerId ?? null,
      participantId: response.participantId,
      role: asSpectator.value || !response.playerId ? 'spectator' : 'player',
      token: response.playerSessionToken,
      dealerSecret: null
    })

    if (accountStore.token) await loadMe().catch(() => undefined)
    await navigateTo(response.playerUrl)
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Ошибка входа')
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <main class="page-shell join-room-page">
    <header>
      <h1 class="page-title">Вход в комнату {{ code }}</h1>
      <h2 v-if="lobby">{{ lobby.name }}</h2>
      <p class="page-subtitle">Введите имя и подключитесь к столу.</p>
    </header>

    <ReservedRooms />
    <section class="panel join-room-page__form">
      <p v-if="lobby">{{ lobby.playerPolicy === 'accounts' ? 'Только пользователи с аккаунтами' : lobby.playerPolicy === 'guests' ? 'Гостевой стол' : 'Аккаунты и гости' }}</p>
      <NuxtLink v-if="lobby?.playerPolicy === 'accounts' && !accountStore.user" class="btn" to="/">Войти в аккаунт</NuxtLink>
      <label v-if="lobby?.hasPassword">
        <span>Пароль комнаты</span>
        <input v-model="password" class="input" type="password" autocomplete="current-password" maxlength="128" required>
      </label>
      <p v-if="accessNotice" class="join-room-page__notice">{{ accessNotice }}</p>
      <p v-if="accountStore.user" class="join-room-page__account-info">
        Аккаунт: <strong>{{ accountStore.user.username }}</strong> · Баланс: <strong>{{ accountStore.user.balance }}</strong>
      </p>

      <label>
        <span>Имя</span>
        <input v-model="name" class="input" type="text" required>
      </label>

      <label v-if="lobby?.allowSpectators" class="check">
        <input v-model="asSpectator" type="checkbox">
        <span>Войти как зритель</span>
      </label>

      <label v-if="accountStore.user && lobby?.playerPolicy === 'mixed'" class="check">
        <input v-model="useAccount" type="checkbox">
        <span>Войти с аккаунт-балансом</span>
      </label>

      <section v-if="accountStore.user && useAccount && !asSpectator && lobby?.buyInEnabled" class="buy-in-card">
        <div>
          <strong>Сколько взять за стол?</strong>
          <p>Можно выбрать от {{ lobby.minBuyIn }} до {{ lobby.maxBuyIn }}. Остаток останется в кошельке аккаунта.</p>
        </div>
        <template v-if="canAffordBuyIn">
          <input v-model.number="buyInAmount" class="buy-in-card__range" type="range" :min="lobby.minBuyIn" :max="allowedBuyInMax" :step="1">
          <input v-model.number="buyInAmount" class="input" type="number" :min="lobby.minBuyIn" :max="allowedBuyInMax" required>
          <div class="buy-in-card__presets">
            <button v-for="preset in buyInPresets" :key="preset" class="btn btn--ghost" type="button" @click="buyInAmount = preset">
              {{ preset === lobby.minBuyIn ? 'Минимум' : preset === allowedBuyInMax ? 'Максимум' : 'Середина' }} · {{ preset }}
            </button>
          </div>
          <div class="buy-in-card__summary">
            <span>За столом: <b>{{ buyInAmount }}</b></span>
            <span>В кошельке останется: <b>{{ Math.max(0, accountStore.user.balance - buyInAmount) }}</b></span>
          </div>
        </template>
        <p v-else class="error">Для входа нужно минимум {{ lobby.minBuyIn }} свободных фишек. Сейчас доступно {{ accountStore.user.balance }}.</p>
      </section>

      <p v-if="lobby?.predictionsEnabled && !asSpectator" class="join-room-page__prediction-note">
        На каждую раздачу выдаётся 3 жетона прогнозов. Награды поступают на основной баланс из части чистого выигрыша победителя. После вылета можно пополнить стек между раздачами.
      </p>

      <button type="button" class="btn" :disabled="isLoading || !name.trim() || !lobby || (lobby.hasPassword && !password) || (lobby.playerPolicy === 'accounts' && !accountStore.user) || Boolean(accountStore.user && useAccount && !asSpectator && lobby.buyInEnabled && (!canAffordBuyIn || buyInAmount < lobby.minBuyIn || buyInAmount > lobby.maxBuyIn || buyInAmount > accountStore.user.balance))" @click="submit">
        {{ accountStore.user && useAccount && !asSpectator && lobby?.buyInEnabled ? `Сесть за стол с ${buyInAmount}` : 'Присоединиться' }}
      </button>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.join-room-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__form {
    display: grid;
    gap: 0.8rem;
  }
}

.join-room-page__account-info {
  margin: 0;
  color: var(--text-muted);
}

.join-room-page__notice {
  margin: 0;
  color: var(--accent-strong);
}

.join-room-page__prediction-note {
  margin: 0;
  padding: 0.75rem;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  background: rgba(240, 188, 79, 0.08);
  border: 1px solid rgba(240, 188, 79, 0.2);
}

.buy-in-card {
  display: grid;
  gap: 0.7rem;
  padding: 0.9rem;
  border-radius: var(--radius-md);
  border: 1px solid rgba(240, 188, 79, 0.3);
  background: linear-gradient(145deg, rgba(240, 188, 79, 0.1), rgba(0, 0, 0, 0.16));

  p {
    margin: 0.25rem 0 0;
    color: var(--text-muted);
    line-height: 1.4;
  }

  &__summary {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    color: var(--text-muted);
  }

  &__range {
    width: 100%;
    accent-color: var(--accent);
  }

  &__presets {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;

    .btn {
      min-height: 40px;
      padding: 0.45rem 0.7rem;
    }
  }
}

.check {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.error {
  color: var(--danger);
  margin: 0;
}
</style>
