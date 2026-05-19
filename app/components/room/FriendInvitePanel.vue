<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { FriendItem } from '~/types/social'

const props = defineProps<{
  roomCode: string
  connectedUserIds: string[]
}>()

const accountStore = useAccountStore()

const friends = ref<FriendItem[]>([])
const selectedFriendId = ref('')
const isLoading = ref(false)
const isSending = ref(false)
const localError = ref('')
const localSuccess = ref('')

const availableFriends = computed(() =>
  friends.value.filter((item) => !props.connectedUserIds.includes(item.friend.id))
)

async function loadFriends() {
  if (!accountStore.token) {
    friends.value = []
    return
  }

  isLoading.value = true
  localError.value = ''

  try {
    const response = await $fetch<{ friends: FriendItem[] }>('/api/friends/list', {
      method: 'POST',
      body: { token: accountStore.token }
    })

    friends.value = response.friends
    if (!availableFriends.value.some((item) => item.friend.id === selectedFriendId.value)) {
      selectedFriendId.value = availableFriends.value[0]?.friend.id || ''
    }
  } catch (error) {
    localError.value = getHttpErrorMessage(error, 'Не удалось загрузить список друзей')
  } finally {
    isLoading.value = false
  }
}

async function sendInvite() {
  if (!accountStore.token || !selectedFriendId.value || isSending.value) {
    return
  }

  isSending.value = true
  localError.value = ''
  localSuccess.value = ''

  try {
    await $fetch('/api/rooms/' + props.roomCode + '/invite-friend', {
      method: 'POST',
      body: {
        token: accountStore.token,
        friendUserId: selectedFriendId.value
      }
    })

    localSuccess.value = 'Приглашение отправлено'
  } catch (error) {
    localError.value = getHttpErrorMessage(error, 'Не удалось отправить приглашение')
  } finally {
    isSending.value = false
  }
}

watch(
  () => props.connectedUserIds,
  () => {
    if (selectedFriendId.value && !availableFriends.value.some((item) => item.friend.id === selectedFriendId.value)) {
      selectedFriendId.value = availableFriends.value[0]?.friend.id || ''
    }
  },
  { deep: true }
)

onMounted(() => {
  accountStore.loadSession()
  loadFriends()
})
</script>

<template>
  <section class="panel friend-invite-panel">
    <h3>Пригласить друга</h3>

    <p v-if="!accountStore.token" class="friend-invite-panel__hint">
      Войдите в аккаунт, чтобы приглашать друзей в лобби.
    </p>

    <template v-else>
      <p v-if="!friends.length && !isLoading" class="friend-invite-panel__hint">
        Список друзей пуст.
      </p>
      <p v-else-if="!availableFriends.length && !isLoading" class="friend-invite-panel__hint">
        Все друзья уже в комнате.
      </p>

      <div class="friend-invite-panel__row">
        <select v-model="selectedFriendId" class="select" :disabled="isLoading || !availableFriends.length">
          <option value="" disabled>Выберите друга</option>
          <option v-for="item in availableFriends" :key="item.friend.id" :value="item.friend.id">
            {{ item.friend.username }} · {{ item.friend.balance }}
          </option>
        </select>

        <button
          type="button"
          class="btn"
          :disabled="isSending || !selectedFriendId"
          @click="sendInvite"
        >
          {{ isSending ? 'Отправка...' : 'Пригласить' }}
        </button>
      </div>

      <button type="button" class="btn btn--ghost" :disabled="isLoading" @click="loadFriends">
        {{ isLoading ? 'Обновление...' : 'Обновить друзей' }}
      </button>
    </template>

    <p v-if="localError" class="friend-invite-panel__error">{{ localError }}</p>
    <p v-if="localSuccess" class="friend-invite-panel__success">{{ localSuccess }}</p>
  </section>
</template>

<style scoped lang="scss">
.friend-invite-panel {
  display: grid;
  gap: 0.6rem;

  h3,
  p {
    margin: 0;
  }

  &__hint {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__row {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: 1fr auto;
  }

  &__error {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  &__success {
    color: var(--success);
    font-size: var(--text-sm);
  }
}

@media (max-width: 860px) {
  .friend-invite-panel {
    &__row {
      grid-template-columns: 1fr;
    }
  }
}
</style>
