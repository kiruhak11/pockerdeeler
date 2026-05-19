<script setup lang="ts">
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { getHttpErrorMessage } from '~/utils/httpError'

const props = withDefaults(defineProps<{
  roomCode: string
  role?: 'dealer' | 'player' | 'spectator' | 'viewer'
  title?: string
}>(), {
  role: 'viewer',
  title: 'Чат комнаты'
})

const roomStore = useRoomStore()
const sessionStore = usePlayerSessionStore()

const text = ref('')
const sending = ref(false)
const localError = ref('')

const isReadOnly = computed(() => props.role === 'viewer')

const sortedMessages = computed(() => roomStore.chatMessages)

async function sendMessage() {
  if (sending.value || isReadOnly.value) {
    return
  }

  const message = text.value.trim()
  if (!message) {
    return
  }

  sending.value = true
  localError.value = ''

  try {
    const payload: {
      message: string
      participantId?: string
      token?: string
      dealerSecret?: string
    } = {
      message
    }

    if (props.role === 'dealer') {
      if (!sessionStore.dealerSecret) {
        throw new Error('Секрет дилера не найден')
      }
      payload.dealerSecret = sessionStore.dealerSecret
    } else {
      if (!sessionStore.participantId || !sessionStore.token) {
        throw new Error('Сессия участника не найдена')
      }

      payload.participantId = sessionStore.participantId
      payload.token = sessionStore.token
    }

    const response = await $fetch<{
      success: boolean
      state?: import('~/types/room').RoomState
    }>(`/api/rooms/${props.roomCode}/chat`, {
      method: 'POST',
      body: payload
    })

    if (response.state) {
      roomStore.setRoomState(response.state)
    }

    text.value = ''
  } catch (error) {
    localError.value = getHttpErrorMessage(error, 'Не удалось отправить сообщение')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <section class="panel room-chat-panel">
    <h3>{{ title }}</h3>

    <div class="room-chat-panel__messages">
      <p v-if="!sortedMessages.length" class="room-chat-panel__empty">Сообщений пока нет</p>
      <article v-for="message in sortedMessages" :key="message.id" class="room-chat-panel__message">
        <header>
          <strong>{{ message.senderName }}</strong>
          <time>{{ new Date(message.createdAt).toLocaleTimeString() }}</time>
        </header>
        <p>{{ message.text }}</p>
      </article>
    </div>

    <p v-if="localError" class="room-chat-panel__error">{{ localError }}</p>

    <div v-if="!isReadOnly" class="room-chat-panel__composer">
      <input
        v-model="text"
        class="input"
        type="text"
        maxlength="300"
        placeholder="Введите сообщение"
        :disabled="sending"
        @keydown.enter.prevent="sendMessage"
      >
      <button type="button" class="btn" :disabled="sending || !text.trim()" @click="sendMessage">
        {{ sending ? 'Отправка...' : 'Отправить' }}
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.room-chat-panel {
  display: grid;
  gap: 0.65rem;

  h3 {
    margin: 0;
  }

  &__messages {
    display: grid;
    gap: 0.45rem;
    max-height: 260px;
    overflow-y: auto;
    padding-right: 0.2rem;
  }

  &__message {
    padding: 0.55rem;
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.06);

    header {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      color: var(--text-muted);
      font-size: var(--text-xs);
      margin-bottom: 0.3rem;

      strong {
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
    }

    p {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }

  &__composer {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.45rem;
  }

  &__empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
  }
}

@media (max-width: 680px) {
  .room-chat-panel {
    &__composer {
      grid-template-columns: 1fr;
    }
  }
}
</style>
