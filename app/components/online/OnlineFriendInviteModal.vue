<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import type { FriendItem } from '~/types/social'

const props = defineProps<{ roomCode: string }>()
const accountStore = useAccountStore()
const isOpen = ref(false)
const friends = ref<FriendItem[]>([])
const sentStatus = ref<Record<string, 'sent' | 'duplicate'>>({})
const sendingFriendId = ref('')
const isLoading = ref(false)
const localError = ref('')
const localSuccess = ref('')

async function loadFriends() {
  if (!accountStore.token) {
    localError.value = 'Войдите в аккаунт, чтобы приглашать друзей.'
    return
  }
  isLoading.value = true
  localError.value = ''
  try {
    const response = await $fetch<{ friends: FriendItem[] }>('/api/friends/list', {
      method: 'POST', body: { token: accountStore.token }, retry: 0
    })
    friends.value = response.friends
  } catch {
    localError.value = 'Не удалось загрузить список друзей. Попробуйте ещё раз.'
  } finally {
    isLoading.value = false
  }
}

function openInvite() {
  isOpen.value = true
  localError.value = ''
  localSuccess.value = ''
  accountStore.loadSession()
  void loadFriends()
}

function inviteError(error: unknown): string {
  const status = (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
  if (status === 401) return 'Войдите в аккаунт, чтобы отправить приглашение.'
  if (status === 403) return 'Пригласить можно только друга, находясь за этим столом.'
  if (status === 404) return 'Друг или онлайн-комната больше недоступны.'
  if (status === 409 || status === 410) return 'Онлайн-комната уже закрыта или недоступна.'
  return 'Не удалось отправить приглашение. Попробуйте ещё раз.'
}

async function sendInvite(friend: FriendItem['friend']) {
  if (!accountStore.token || sendingFriendId.value) return
  sendingFriendId.value = friend.id
  localError.value = ''
  localSuccess.value = ''
  try {
    const result = await $fetch<{ sent: boolean; duplicate: boolean }>(`/api/online/rooms/${encodeURIComponent(props.roomCode)}/invite-friend`, {
      method: 'POST',
      body: { token: accountStore.token, friendUserId: friend.id },
      retry: 0
    })
    sentStatus.value = { ...sentStatus.value, [friend.id]: result.duplicate ? 'duplicate' : 'sent' }
    localSuccess.value = result.duplicate ? `Недавно уже приглашали ${friend.username}.` : `Приглашение отправлено: ${friend.username}.`
  } catch (error) {
    localError.value = inviteError(error)
  } finally {
    sendingFriendId.value = ''
  }
}

async function copyRoomLink() {
  const link = `${window.location.origin}/online/${encodeURIComponent(props.roomCode)}?join=1`
  try {
    await navigator.clipboard.writeText(link)
  } catch {
    const input = document.createElement('textarea')
    input.value = link
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    const copied = document.execCommand('copy')
    input.remove()
    if (!copied) {
      localError.value = 'Не удалось скопировать ссылку. Скопируйте её вручную.'
      return
    }
  }
  localError.value = ''
  localSuccess.value = 'Ссылка на онлайн-стол скопирована.'
}
</script>

<template>
  <button class="btn btn--ghost online-friend-invite-trigger" type="button" @click="openInvite">Пригласить друга</button>
  <Teleport to="body">
    <div v-if="isOpen" class="online-friend-invite-overlay" @click.self="isOpen = false" @keydown.esc.stop.prevent="isOpen = false">
      <section class="panel online-friend-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="online-friend-invite-title">
        <header class="online-friend-invite-dialog__header">
          <div><span class="section-kicker">ONLINE · {{ roomCode }}</span><h2 id="online-friend-invite-title">Пригласить друга</h2></div>
          <button class="online-friend-invite-dialog__close" type="button" aria-label="Закрыть" @click="isOpen = false">×</button>
        </header>
        <p class="online-friend-invite-dialog__hint">Приглашение придёт через доступные уведомления. Пароль приватной комнаты не отправляется.</p>
        <button class="btn btn--ghost online-friend-invite-dialog__copy" type="button" @click="copyRoomLink">Скопировать ссылку</button>
        <p v-if="isLoading" class="online-friend-invite-dialog__hint" role="status">Загружаем друзей…</p>
        <p v-else-if="!friends.length" class="online-friend-invite-dialog__hint">Список друзей пуст.</p>
        <ul v-else class="online-friend-invite-list">
          <li v-for="item in friends" :key="item.friend.id" class="online-friend-invite-row">
            <span class="online-friend-invite-row__avatar" aria-hidden="true">{{ item.friend.username.slice(0, 1).toUpperCase() }}</span>
            <strong class="online-friend-invite-row__name">{{ item.friend.username }}</strong>
            <span v-if="sentStatus[item.friend.id] === 'sent'" class="online-friend-invite-row__status">Отправлено</span>
            <span v-else-if="sentStatus[item.friend.id] === 'duplicate'" class="online-friend-invite-row__status">Уже приглашён</span>
            <button v-else class="btn" type="button" :disabled="Boolean(sendingFriendId)" @click="sendInvite(item.friend)">{{ sendingFriendId === item.friend.id ? 'Отправляем…' : 'Пригласить' }}</button>
          </li>
        </ul>
        <p v-if="localError" class="online-friend-invite-dialog__error" role="alert">{{ localError }}</p>
        <p v-if="localSuccess" class="online-friend-invite-dialog__success" role="status" aria-live="polite">{{ localSuccess }}</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.online-friend-invite-trigger { max-width: 170px; min-height: 40px; padding: .4rem .6rem; text-align: center; white-space: normal; }
.online-friend-invite-overlay { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.68); }
.online-friend-invite-dialog { display: grid; gap: .85rem; width: min(100%, 480px); max-height: min(72dvh, 620px); overflow: auto; padding: 1.15rem; border-color: rgba(102,190,255,.32); background: linear-gradient(145deg, #173b46, #10252e); }
.online-friend-invite-dialog__header { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; h2 { margin: .2rem 0 0; font-size: 1.25rem; } }
.online-friend-invite-dialog__close { flex: 0 0 auto; width: 40px; height: 40px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; color: inherit; background: rgba(255,255,255,.05); font-size: 1.5rem; cursor: pointer; }
.online-friend-invite-dialog__hint { margin: 0; color: var(--text-muted); font-size: .85rem; }
.online-friend-invite-dialog__copy { justify-self: start; }
.online-friend-invite-list { display: grid; gap: .5rem; max-height: 36dvh; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.online-friend-invite-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: .65rem; min-width: 0; padding: .55rem; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; background: rgba(255,255,255,.035); }
.online-friend-invite-row__avatar { display: grid; place-items: center; width: 2.35rem; height: 2.35rem; border-radius: 12px; color: #f5d989; background: linear-gradient(145deg,#2c5a45,#142d22); font-weight: 900; }
.online-friend-invite-row__name { min-width: 0; overflow-wrap: anywhere; }
.online-friend-invite-row__status { color: var(--success); font-size: .78rem; text-align: right; }
.online-friend-invite-dialog__error,.online-friend-invite-dialog__success { margin: 0; font-size: .85rem; }
.online-friend-invite-dialog__error { color: var(--danger); }.online-friend-invite-dialog__success { color: var(--success); }
@media (max-width: 600px) {
  .online-friend-invite-overlay { align-items: end; padding: .5rem .6rem calc(68px + env(safe-area-inset-bottom, 0px)); }
  .online-friend-invite-dialog { width: 100%; max-height: min(68dvh,560px); padding: 1rem; border-radius: 22px; }
  .online-friend-invite-row { grid-template-columns: auto minmax(0,1fr); }
  .online-friend-invite-row .btn,.online-friend-invite-row__status { grid-column: 2; justify-self: start; }
  .online-friend-invite-dialog__copy { width: 100%; }
}
</style>
