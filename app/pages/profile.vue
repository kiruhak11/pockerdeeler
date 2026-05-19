<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { FriendItem, FriendRequestItem, RoomInviteItem } from '~/types/social'

const accountStore = useAccountStore()
const { loadMe, updateUsername, changePassword } = useAccountAuth()

const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const usernameForm = reactive({
  username: ''
})

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const friendUsername = ref('')
const friends = ref<FriendItem[]>([])
const requests = ref<FriendRequestItem[]>([])
const invites = ref<RoomInviteItem[]>([])

const incomingRequests = computed(() => requests.value.filter((item) => item.direction === 'incoming' && item.status === 'pending'))
const outgoingRequests = computed(() => requests.value.filter((item) => item.direction === 'outgoing'))

const isAuthenticated = computed(() => Boolean(accountStore.token && accountStore.user))

async function loadSocialData() {
  if (!accountStore.token) {
    return
  }

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

async function initialize() {
  accountStore.loadSession()

  if (!accountStore.token) {
    return
  }

  loading.value = true
  errorMessage.value = ''

  try {
    await loadMe()
    usernameForm.username = accountStore.user?.username || ''
    await loadSocialData()
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось загрузить данные профиля')
    accountStore.clearSession()
  } finally {
    loading.value = false
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

async function onChangePassword() {
  if (!accountStore.token) {
    return
  }

  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    errorMessage.value = 'Подтверждение пароля не совпадает'
    return
  }

  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    await changePassword(passwordForm.currentPassword, passwordForm.newPassword)
    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    successMessage.value = 'Пароль успешно изменен'
  } catch (error) {
    errorMessage.value = getHttpErrorMessage(error, 'Не удалось изменить пароль')
  } finally {
    loading.value = false
  }
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
    <header>
      <h1 class="page-title">Личный кабинет</h1>
      <p class="page-subtitle">Профиль, друзья и приглашения в игровые лобби.</p>
    </header>

    <section v-if="!isAuthenticated" class="panel profile-page__panel">
      <p>Вы не авторизованы.</p>
      <NuxtLink class="btn" to="/">На главную</NuxtLink>
    </section>

    <template v-else>
      <p v-if="errorMessage" class="profile-page__error">{{ errorMessage }}</p>
      <p v-if="successMessage" class="profile-page__success">{{ successMessage }}</p>

      <section class="panel profile-page__panel">
        <h2>Профиль</h2>
        <p>Баланс аккаунта: <strong>{{ accountStore.user?.balance }}</strong></p>

        <div class="profile-page__row">
          <input v-model="usernameForm.username" class="input" type="text" placeholder="Имя пользователя">
          <button type="button" class="btn" :disabled="loading || !usernameForm.username.trim()" @click="onUpdateUsername">
            Сменить имя
          </button>
        </div>
      </section>

      <section class="panel profile-page__panel">
        <h2>Смена пароля</h2>
        <div class="profile-page__grid">
          <input v-model="passwordForm.currentPassword" class="input" type="password" placeholder="Текущий пароль">
          <input v-model="passwordForm.newPassword" class="input" type="password" placeholder="Новый пароль">
          <input v-model="passwordForm.confirmPassword" class="input" type="password" placeholder="Подтвердите пароль">
        </div>

        <button
          type="button"
          class="btn"
          :disabled="loading || !passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword"
          @click="onChangePassword"
        >
          Сменить пароль
        </button>
      </section>

      <section class="panel profile-page__panel">
        <h2>Друзья</h2>

        <div class="profile-page__row">
          <input v-model="friendUsername" class="input" type="text" placeholder="Логин пользователя">
          <button type="button" class="btn" :disabled="loading || !friendUsername.trim()" @click="onSendFriendRequest">
            Добавить в друзья
          </button>
        </div>

        <h3>Мои друзья</h3>
        <ul v-if="friends.length" class="profile-page__list">
          <li v-for="item in friends" :key="item.friendshipId">
            <span>{{ item.friend.username }}</span>
            <span>{{ item.friend.balance }}</span>
          </li>
        </ul>
        <p v-else class="profile-page__muted">Друзей пока нет.</p>

        <h3>Входящие заявки</h3>
        <ul v-if="incomingRequests.length" class="profile-page__list">
          <li v-for="item in incomingRequests" :key="item.id" class="profile-page__request-item">
            <span>{{ item.fromUser.username }}</span>
            <div>
              <button type="button" class="btn btn--success" :disabled="loading" @click="onRespondRequest(item.id, 'accept')">Принять</button>
              <button type="button" class="btn btn--danger" :disabled="loading" @click="onRespondRequest(item.id, 'reject')">Отклонить</button>
            </div>
          </li>
        </ul>
        <p v-else class="profile-page__muted">Нет входящих заявок.</p>

        <h3>Исходящие заявки</h3>
        <ul v-if="outgoingRequests.length" class="profile-page__list">
          <li v-for="item in outgoingRequests" :key="item.id">
            <span>{{ item.toUser.username }}</span>
            <span>{{ item.status }}</span>
          </li>
        </ul>
        <p v-else class="profile-page__muted">Нет исходящих заявок.</p>
      </section>

      <section class="panel profile-page__panel">
        <h2>Приглашения в лобби</h2>

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

      <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
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
}
</style>
