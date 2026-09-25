<script setup lang="ts">
import { getHttpErrorMessage } from '~/utils/httpError'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { useAccountStore } from '~/stores/account'

const account = useAccountStore()
const { loadMe } = useAccountAuth()
const visibility = ref<'PUBLIC' | 'PRIVATE'>('PUBLIC')
const privateJoinSecret = ref('')
const startingStack = ref(1000)
const smallBlind = ref(5)
const bigBlind = ref(10)
const busy = ref(false)
const error = ref('')

async function createRoom() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!account.user) await loadMe()
    if (!account.user) {
      await navigateTo('/login?redirect=/online/create')
      return
    }
    const result = await $fetch<{ room: { roomCode: string } }>('/api/online/rooms', {
      method: 'POST',
      body: {
        visibility: visibility.value,
        startingStack: startingStack.value,
        smallBlind: smallBlind.value,
        bigBlind: bigBlind.value,
        ...(visibility.value === 'PRIVATE' ? { privateJoinSecret: privateJoinSecret.value } : {})
      },
      retry: 0
    })
    privateJoinSecret.value = ''
    await navigateTo(`/online/${result.room.roomCode}`)
  } catch (cause) {
    const status = (cause as { statusCode?: number; status?: number }).statusCode ?? (cause as { statusCode?: number; status?: number }).status
    if (status === 401) {
      await navigateTo('/login?redirect=/online/create')
    } else {
      error.value = getHttpErrorMessage(cause, 'Не удалось создать онлайн-стол. Попробуйте ещё раз.')
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => { void loadMe().catch(() => {}) })
useHead({ title: 'Создать онлайн-стол · Poker Dealer Desk' })
</script>

<template>
  <main class="page-shell online-create">
    <NuxtLink class="online-create__back" to="/rooms">← К столам</NuxtLink>
    <section class="panel online-create__panel">
      <span class="eyebrow">ONLINE</span>
      <h1>Создать онлайн-стол</h1>
      <p class="page-subtitle">Получите код комнаты и пригласите друзей. Фишки, карты и ставки ведёт сервер.</p>
      <div class="online-create__visibility" aria-label="Доступ к столу">
        <button type="button" :class="{ active: visibility === 'PUBLIC' }" :aria-pressed="visibility === 'PUBLIC'" @click="visibility = 'PUBLIC'">Публичный</button>
        <button type="button" :class="{ active: visibility === 'PRIVATE' }" :aria-pressed="visibility === 'PRIVATE'" @click="visibility = 'PRIVATE'">Приватный</button>
      </div>
      <label v-if="visibility === 'PRIVATE'">Пароль для приглашённых
        <input v-model="privateJoinSecret" class="input" type="password" autocomplete="new-password" maxlength="128" placeholder="Придумайте пароль">
      </label>
      <p v-if="visibility === 'PRIVATE'" class="page-subtitle">Пароль не добавляется в ссылку и не сохраняется в браузере.</p>
      <div class="online-create__settings">
        <label>Стартовый стек
          <input v-model.number="startingStack" class="input" type="number" min="1" max="1000000" required>
        </label>
        <label>Малый блайнд
          <input v-model.number="smallBlind" class="input" type="number" min="1" max="1000000" required>
        </label>
        <label>Большой блайнд
          <input v-model.number="bigBlind" class="input" type="number" :min="smallBlind" max="1000000" required>
        </label>
      </div>
      <p v-if="error" class="online-create__error" role="alert">{{ error }}</p>
      <button class="btn" type="button" :disabled="busy || (visibility === 'PRIVATE' && !privateJoinSecret)" @click="createRoom">{{ busy ? 'Создаём…' : 'Создать стол' }}</button>
      <NuxtLink class="online-create__home-link" to="/create">Нужен стол с настоящими картами? Создать домашнюю игру</NuxtLink>
    </section>
  </main>
</template>

<style scoped lang="scss">
.online-create { max-width: 680px; padding-block: 1.2rem 3rem; }
.online-create__back { color: var(--accent-strong); }
.online-create__panel { display: grid; gap: 1rem; margin-top: .8rem; padding: clamp(1rem, 4vw, 2rem); border-color: rgba(102,190,255,.3); background: linear-gradient(145deg, #173b46, #10252e); }
.online-create h1 { margin: .2rem 0 0; }
.online-create label { display: grid; gap: .4rem; }
.online-create__settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .7rem; }
.online-create__visibility { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .3rem; border-radius: 16px; background: rgba(0,0,0,.2); }
.online-create__visibility button { min-height: 46px; border: 1px solid transparent; border-radius: 13px; color: var(--text-muted); background: transparent; cursor: pointer; }
.online-create__visibility button.active { border-color: rgba(102,190,255,.35); color: var(--text-primary); background: rgba(102,190,255,.14); }
.online-create__error { margin: 0; color: var(--danger); }
.online-create__home-link { justify-self: center; color: var(--text-muted); font-size: .9rem; text-align: center; }
@media (max-width: 620px) { .online-create__settings { grid-template-columns: 1fr; } }
</style>
