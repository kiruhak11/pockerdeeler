<script setup lang="ts">
import { useFloatingRoomChat } from '~/composables/useFloatingRoomChat'
import RoomChatToast from './RoomChatToast.vue'
import { useRoomStore } from '~/stores/room'

const props = withDefaults(defineProps<{
  roomCode: string
  role?: 'dealer' | 'player' | 'spectator' | 'viewer'
  title?: string
}>(), { role: 'viewer', title: 'Чат комнаты' })
const chat = useFloatingRoomChat(toRef(props, 'roomCode'), toRef(props, 'role'))
const premiumEnabled = ref(false)
const { messages, opened, loaded, loading, historyError, sendError, draft, pending, sending, before,
  firstUnread, toast, unreadCount, readOnly } = chat
const room = useRoomStore()
const { preferences } = useGamePreferences()
const dialog = ref<HTMLDialogElement>()
const list = ref<HTMLElement>()
const launcher = ref<HTMLButtonElement>()
const bottom = ref(true)
const historyId = `chat-${useId()}`
const titleId = useId()
const inputId = useId()
let observer: IntersectionObserver | undefined
let resizeObserver: ResizeObserver | undefined
let oldOverflow = ''
let modalActive = false
let openingScroll = false
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function viewport() {
  const view = window.visualViewport
  dialog.value?.style.setProperty('--chat-height', `${view?.height || window.innerHeight}px`)
  dialog.value?.style.setProperty('--chat-top', `${view?.offsetTop || 0}px`)
}
function scrollBottom(smooth = false) {
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'instant' })
}
function onScroll() {
  const node = list.value
  if (node) bottom.value = node.scrollHeight - node.scrollTop - node.clientHeight < 48
}
function observeMessages() {
  observer?.disconnect()
  if (!list.value || !loaded.value) return
  observer = new IntersectionObserver(entries => {
    chat.markSeen(entries.filter(entry => entry.isIntersecting && entry.intersectionRatio >= 0.6)
      .map(entry => (entry.target as HTMLElement).dataset.messageId!).filter(Boolean))
  }, { root: list.value, threshold: [0.6, 1] })
  list.value.querySelectorAll('[data-message-id]').forEach(node => observer!.observe(node))
}
async function openChat() {
  if (opened.value) return
  bottom.value = true
  openingScroll = true
  history.pushState({ ...history.state, roomChat: historyId }, '', location.href)
  await chat.open()
  await nextTick()
  scrollBottom()
  openingScroll = false
  observeMessages()
}
function closeChat(fromBack = false) {
  if (!opened.value) return
  chat.close()
  if (!fromBack && history.state?.roomChat === historyId) history.back()
}
function back() { if (opened.value) closeChat(true) }
async function older() {
  const node = list.value
  if (!node) return
  const anchor = node.querySelector<HTMLElement>('[data-message-id]')
  const id = anchor?.dataset.messageId
  const top = anchor?.getBoundingClientRect().top || 0
  await chat.loadOlder()
  await nextTick()
  const same = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === id)
  if (same) node.scrollTop += same.getBoundingClientRect().top - top
  onScroll()
}
watch(opened, async value => {
  await nextTick()
  if (value && dialog.value && !dialog.value.open) {
    oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    modalActive = true
    viewport()
    dialog.value.showModal()
    // Keep the keyboard closed until the user intentionally focuses the composer.
    dialog.value.querySelector<HTMLButtonElement>('[data-close]')?.focus()
  } else if (!value) {
    dialog.value?.close()
    if (modalActive) document.body.style.overflow = oldOverflow
    modalActive = false
    observer?.disconnect()
    launcher.value?.focus({ preventScroll: true })
  }
})
watch(() => messages.value.map(message => message.id).join(','), async () => {
  const follow = bottom.value && !loading.value
  await nextTick()
  if (opened.value) {
    if (follow && !openingScroll) scrollBottom(true)
    observeMessages()
  }
})
watch(loaded, async () => { await nextTick(); observeMessages() })
function visibility() { if (document.visibilityState === 'visible' && opened.value) observeMessages() }
onMounted(() => {
  window.addEventListener('popstate', back)
  document.addEventListener('visibilitychange', visibility)
  window.visualViewport?.addEventListener('resize', viewport)
  window.visualViewport?.addEventListener('scroll', viewport)
  resizeObserver = new ResizeObserver(() => { if (opened.value && bottom.value) scrollBottom() })
  if (list.value) resizeObserver.observe(list.value)
  void $fetch<{ features: string[] }>('/api/premium/me').then(access => { premiumEnabled.value = access.features.includes('ROOM_CHAT') }).catch(() => { premiumEnabled.value = false })
})
onBeforeUnmount(() => {
  observer?.disconnect(); resizeObserver?.disconnect()
  window.removeEventListener('popstate', back)
  document.removeEventListener('visibilitychange', visibility)
  window.visualViewport?.removeEventListener('resize', viewport)
  window.visualViewport?.removeEventListener('scroll', viewport)
  if (modalActive) document.body.style.overflow = oldOverflow
  if (history.state?.roomChat === historyId) {
    const state = { ...history.state }; delete state.roomChat
    history.replaceState(state, '', location.href)
  }
})
</script>

<template>
  <span class="room-chat-anchor" aria-hidden="true" />
  <Teleport to="body">
    <button v-if="premiumEnabled" ref="launcher" class="room-chat-launcher" type="button" aria-haspopup="dialog"
      :aria-expanded="opened" :aria-label="`Открыть чат комнаты${unreadCount ? `, непрочитанных: ${unreadCount}` : ''}`" @click="openChat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z" /><path d="M7 10h8M7 14h5" />
      </svg>
      <span v-if="unreadCount" class="room-chat-launcher__badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>
    <RoomChatToast v-if="premiumEnabled && toast && !opened && preferences.chatToasts && preferences.notifications" :key="toast.id" :message="toast" @shown="chat.toastShown" @open="openChat" />
    <dialog v-if="premiumEnabled" ref="dialog" class="room-chat-dialog" :aria-labelledby="titleId" @cancel.prevent="closeChat()" @click="event => { if (event.target === dialog) closeChat() }">
      <section class="room-chat-dialog__shell">
        <header class="room-chat-dialog__header">
          <div><h2 :id="titleId">{{ title }}</h2><p>{{ room.room?.name || 'Комната' }} · {{ roomCode }}</p></div>
          <button type="button" class="room-chat-dialog__close" data-close aria-label="Закрыть чат" @click="closeChat()">×</button>
        </header>
        <div ref="list" class="room-chat-dialog__messages" tabindex="0" aria-label="Сообщения комнаты" :aria-busy="loading" @scroll.passive="onScroll">
          <button v-if="before && loaded" class="btn btn--ghost room-chat-dialog__older" type="button" :disabled="loading" @click="older">Загрузить предыдущие</button>
          <p v-if="loading" role="status" class="room-chat-dialog__muted">Загружаем сообщения...</p>
          <div v-if="historyError" class="room-chat-dialog__error" role="status">
            <p>{{ historyError }}</p><button type="button" class="btn btn--ghost" :disabled="loading" @click="chat.loadLatest">Повторить загрузку</button>
          </div>
          <p v-if="loaded && !messages.length && !loading" class="room-chat-dialog__muted">Сообщений пока нет. Начните разговор за столом.</p>
          <template v-for="message in messages" :key="message.id">
            <p v-if="message.id === firstUnread" class="room-chat-dialog__divider">Новые сообщения</p>
            <article :data-message-id="message.id" class="room-chat-dialog__message" :class="{ 'is-own': chat.isOwn(message) }">
              <header><strong>{{ chat.isOwn(message) ? 'Вы' : message.senderName }}</strong><time :datetime="message.createdAt" :title="new Date(message.createdAt).toLocaleString('ru-RU')">{{ new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }}</time></header>
              <p>{{ message.text }}</p>
            </article>
          </template>
        </div>
        <p class="room-chat-sr" aria-live="polite" aria-atomic="true">{{ opened && loaded && messages.length ? `Сообщений загружено: ${messages.length}. Последнее: ${messages.at(-1)?.senderName}: ${messages.at(-1)?.text}` : '' }}</p>
        <button v-if="!bottom && loaded" type="button" class="btn btn--ghost room-chat-dialog__new" @click="scrollBottom(true)">К последним сообщениям ↓</button>
        <footer class="room-chat-dialog__footer">
          <div v-if="pending" class="room-chat-dialog__pending" role="status">
            <p>{{ pending.text }}</p><small>{{ sending ? 'Отправляем...' : 'Не отправлено / ответ не подтверждён' }}</small>
            <p v-if="sendError" class="room-chat-dialog__error">{{ sendError }}</p>
            <button v-if="!sending" type="button" class="btn btn--ghost" @click="chat.send(true)">Повторить отправку</button>
          </div>
          <p v-if="readOnly" class="room-chat-dialog__muted">Общий стол: только просмотр. Пишите с экрана участника.</p>
          <form v-else class="room-chat-dialog__composer" @submit.prevent="chat.send()">
            <label :for="inputId" class="room-chat-sr">Сообщение, до 300 символов</label>
            <textarea :id="inputId" v-model="draft" class="input" rows="2" maxlength="300" placeholder="Сообщение за столом" :disabled="!!pending" @keydown.enter.exact="event => { if (!event.isComposing) { event.preventDefault(); chat.send() } }" />
            <button type="submit" class="btn" :disabled="sending || !!pending || !draft.trim()">Отправить</button>
          </form>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped lang="scss">
.room-chat-anchor { display: none; }
.room-chat-launcher {
  position: fixed; z-index: 45; left: max(12px, env(safe-area-inset-left, 0px));
  bottom: calc(84px + env(safe-area-inset-bottom, 0px)); width: 48px; height: 48px;
  display: grid; place-items: center; border: 1px solid var(--accent); border-radius: 50%;
  background: var(--bg-surface); color: var(--accent); box-shadow: 0 5px 18px #0005; cursor: pointer;
  svg { width: 25px; height: 25px; }
  &__badge { position: absolute; top: -5px; right: -7px; min-width: 23px; padding: 3px 5px; border-radius: 20px; background: var(--accent); color: #17231f; font-size: 12px; font-weight: 700; }
}
.room-chat-dialog {
  padding: 0; border: 1px solid #ffffff26; border-radius: var(--radius-lg); color: var(--text-primary);
  background: var(--bg-surface); width: min(560px, calc(100vw - 20px)); max-width: none;
  height: min(720px, calc(var(--chat-height, 100dvh) - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
  max-height: none; position: fixed; top: calc(var(--chat-top, 0px) + env(safe-area-inset-top, 0px) + 12px); bottom: auto; margin: 0 auto;
  overscroll-behavior: contain;
  &::backdrop { background: #020d09b8; backdrop-filter: blur(3px); }
  &__shell { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  &__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; border-bottom: 1px solid #ffffff15; h2 { font-size: 1.15rem; margin: 0; } p { color: var(--text-muted); font-size: .8rem; margin: 4px 0 0; overflow-wrap: anywhere; } }
  &__close { flex: none; width: 44px; height: 44px; color: inherit; background: transparent; border: 1px solid #ffffff25; border-radius: 50%; font-size: 26px; cursor: pointer; }
  &__messages { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px; scroll-padding: 12px; }
  &__message { width: fit-content; max-width: 90%; padding: 10px 12px; margin: 8px 0; border-radius: 12px 12px 12px 3px; background: var(--bg-surface-muted); overflow-wrap: anywhere;
    header { display: flex; align-items: baseline; gap: 12px; font-size: .85rem; } time { margin-left: auto; color: var(--text-muted); font-size: .7rem; white-space: nowrap; }
    p { margin: 5px 0 0; white-space: pre-wrap; }
    &.is-own { margin-left: auto; background: #294b36; border-radius: 12px 12px 3px 12px; }
  }
  &__divider { display: flex; align-items: center; gap: 10px; color: var(--accent); font-size: .8rem; &::before, &::after { content: ''; flex: 1; height: 1px; background: #f2b45155; } }
  &__older { display: block; margin: 0 auto 12px; }
  &__footer { padding: 12px; border-top: 1px solid #ffffff15; max-height: 48%; overflow: auto; }
  &__composer { display: flex; align-items: flex-end; gap: 8px; textarea { flex: 1; width: 0; min-width: 0; resize: none; font-size: 16px; } button { padding: 12px 10px; font-size: .85rem; } }
  &__muted { color: var(--text-muted); font-size: .9rem; }
  &__error { color: var(--danger); font-size: .85rem; }
  &__pending { border-left: 2px solid var(--accent); padding-left: 10px; margin-bottom: 10px; p { margin: 4px 0; overflow-wrap: anywhere; } small { color: var(--text-muted); } }
  &__new { margin: 4px 12px; }
}
.room-chat-sr { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
button:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) { .room-chat-dialog[open] { animation: chat-arrive .16s ease-out; } @keyframes chat-arrive { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } } }
</style>
