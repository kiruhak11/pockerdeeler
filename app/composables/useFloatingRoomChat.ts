import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { getHttpErrorMessage } from '~/utils/httpError'
import type { RoomChatMessage, RoomChatPage } from '~/types/social'

const MAX_MESSAGES = 240
const MAX_RECEIPTS = 2000
export function chatOrder(a: Pick<RoomChatMessage, 'id' | 'createdAt'>, b: Pick<RoomChatMessage, 'id' | 'createdAt'>) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function useFloatingRoomChat(code: Ref<string>, role: Ref<string>) {
  const room = useRoomStore()
  const session = usePlayerSessionStore()
  const messages = ref<RoomChatMessage[]>([])
  const opened = ref(false)
  const loaded = ref(false)
  const loading = ref(false)
  const historyError = ref('')
  const sendError = ref('')
  const draft = ref('')
  const pending = ref<{ text: string; clientRequestId: string } | null>(null)
  const sending = ref(false)
  const before = ref<string | null>(null)
  const firstUnread = ref<string | null>(null)
  const toast = ref<RoomChatMessage | null>(null)
  const visible = ref(true)
  const seen = ref(new Set<string>())
  const unread = ref(new Set<string>())
  const notified = new Set<string>()
  const deleted = new Set<string>()
  let queue: RoomChatMessage[] = []
  let initialSnapshot = true
  let lastSnapshot: RoomChatMessage[] = []
  let newest: RoomChatMessage | undefined
  let notificationFloor: Pick<RoomChatMessage, 'id' | 'createdAt'> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let historyRun = 0
  let deletionTimer: ReturnType<typeof setTimeout> | undefined
  let checkingDeletes = false
  let epoch = 0
  let mounted = false
  let syncAgain = false
  const selfId = computed(() => role.value === 'dealer' || (role.value === 'viewer' && session.role === 'dealer')
    ? room.room?.dealerId : session.participantId)
  const readOnly = computed(() => role.value === 'viewer')
  const unreadCount = computed(() => unread.value.size)
  const storageKey = computed(() => `poker-chat-v1:${code.value}:${selfId.value || 'viewer'}`)
  const isOwn = (message: RoomChatMessage) => Boolean(message.participantId && message.participantId === selfId.value)
  const token = () => {
    if (session.roomCode !== code.value) throw new Error('Войдите в эту комнату для просмотра чата')
    const value = session.role === 'dealer' ? session.dealerSecret : session.token
    if (!value) throw new Error('Сессия комнаты не найдена')
    return value
  }
  function persist() {
    try {
      localStorage.setItem(storageKey.value, JSON.stringify({ seen: [...seen.value].slice(-MAX_RECEIPTS), notified: [...notified].slice(-MAX_RECEIPTS), pending: pending.value,
        notificationFloor: notificationFloor ? { id: notificationFloor.id, createdAt: notificationFloor.createdAt } : undefined }))
    } catch { /* Storage can be unavailable in private mode. */ }
  }
  function restore() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey.value) || '{}')
      if (Array.isArray(data.seen)) seen.value = new Set(data.seen.filter((id: unknown) => typeof id === 'string').slice(-MAX_RECEIPTS))
      if (Array.isArray(data.notified)) for (const id of data.notified.slice(-MAX_RECEIPTS)) if (typeof id === 'string') notified.add(id)
      if (data.pending && typeof data.pending.text === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(data.pending.clientRequestId)) {
        pending.value = { text: data.pending.text.slice(0, 300), clientRequestId: data.pending.clientRequestId }
        sendError.value = 'Отправка не подтверждена. Повторите с тем же ключом.'
      }
      if (typeof data.notificationFloor?.id === 'string' && typeof data.notificationFloor?.createdAt === 'string') notificationFloor = data.notificationFloor
    } catch { /* Ignore invalid or expired local receipts. */ }
  }
  function markSeen(ids: string[]) {
    if (!opened.value || !loaded.value || !visible.value) return
    for (const id of ids) {
      if (!messages.value.some(message => message.id === id)) continue
      seen.value.add(id)
      unread.value.delete(id)
    }
    seen.value = new Set([...seen.value].slice(-MAX_RECEIPTS))
    queue = queue.filter(message => !seen.value.has(message.id))
    persist()
  }
  function finishToast() {
    toast.value = null
    toastTimer = setTimeout(showToast, 180)
  }
  function showToast() {
    if (toast.value || !visible.value || opened.value) return
    let next = queue.shift()
    while (next && (seen.value.has(next.id) || notified.has(next.id) || deleted.has(next.id) || isOwn(next))) next = queue.shift()
    if (!next) return
    toast.value = next
    notified.add(next.id)
    if (!notificationFloor || chatOrder(next, notificationFloor) > 0) notificationFloor = next
    persist()
    // The toast component starts both its progress animation and timer after mount.
  }
  function toastShown() {
    clearTimeout(toastTimer)
    toastTimer = setTimeout(finishToast, 3000)
  }
  function removeMessage(id: string) {
    deleted.add(id)
    unread.value.delete(id)
    queue = queue.filter(message => message.id !== id)
    if (toast.value?.id === id) { clearTimeout(toastTimer); toast.value = null }
  }
  function ingest(rows: RoomChatMessage[], source: 'snapshot' | 'history' | 'older' | 'send') {
    const map = new Map(messages.value.map(message => [message.id, message]))
    for (const message of [...rows].sort(chatOrder)) {
      if (message.deletedAt) { removeMessage(message.id); map.delete(message.id); continue }
      if (deleted.has(message.id)) continue
      map.set(message.id, { ...map.get(message.id), ...message })
      if (!newest || chatOrder(message, newest) > 0) newest = message
      if (isOwn(message)) {
        if (message.clientRequestId === pending.value?.clientRequestId) { pending.value = null; sendError.value = ''; persist() }
        continue
      }
      if (!seen.value.has(message.id)) unread.value.add(message.id)
      if (source !== 'older' && !seen.value.has(message.id) && !notified.has(message.id)
          && (!notificationFloor || chatOrder(message, notificationFloor) > 0)
          && !queue.some(item => item.id === message.id) && toast.value?.id !== message.id) queue.push(message)
    }
    const sorted = [...map.values()].filter(message => !deleted.has(message.id)).sort(chatOrder)
    messages.value = source === 'older' ? sorted.slice(0, MAX_MESSAGES) : sorted.slice(-MAX_MESSAGES)
    unread.value = new Set([...unread.value].slice(-MAX_RECEIPTS))
    if (source !== 'older') before.value = before.value || (sorted.length > MAX_MESSAGES ? messages.value[0]?.id || null : null)
    showToast()
  }
  async function requestPage(query: { before?: string; after?: string } = {}) {
    return $fetch<RoomChatPage>(`/api/rooms/${encodeURIComponent(code.value)}/chat`, {
      headers: { Authorization: `Bearer ${token()}` }, query: { ...query, limit: 40 }, retry: 0, timeout: 15000
    })
  }
  async function checkOlderDeletions() {
    if (!opened.value || !loaded.value || !visible.value || checkingDeletes) return
    const run = epoch
    const snapshotIds = new Set(lastSnapshot.map(message => message.id))
    const ids = messages.value.filter(message => !snapshotIds.has(message.id)).map(message => message.id)
    checkingDeletes = true
    try {
      for (let offset = 0; offset < ids.length; offset += 60) {
        const result = await $fetch<RoomChatPage>(`/api/rooms/${encodeURIComponent(code.value)}/chat`, {
          headers: { Authorization: `Bearer ${token()}` }, query: { check: ids.slice(offset, offset + 60).join(',') }, retry: 0, timeout: 15000
        })
        if (run !== epoch) return
        for (const id of result.deletedIds || []) removeMessage(id)
        messages.value = messages.value.filter(message => !deleted.has(message.id))
      }
    } catch (error) {
      if (run === epoch) historyError.value = getHttpErrorMessage(error, 'Не удалось проверить обновления истории')
    } finally { checkingDeletes = false }
  }
  async function loadLatest() {
    if (loading.value) { syncAgain = true; return }
    const run = epoch
    const request = ++historyRun
    loading.value = true
    historyError.value = ''
    try {
      const page = await requestPage()
      if (run !== epoch || request !== historyRun) return
      messages.value = []
      before.value = page.nextCursor
      ingest(page.messages, 'history')
      loaded.value = true
    } catch (error) {
      if (run === epoch && request === historyRun) historyError.value = getHttpErrorMessage(error, 'Не удалось загрузить чат')
    } finally {
      if (run === epoch && request === historyRun) { loading.value = false; if (syncAgain) { syncAgain = false; void syncHistory() } }
    }
  }
  async function loadOlder() {
    if (!before.value || loading.value) return
    const run = epoch
    const request = ++historyRun
    loading.value = true
    historyError.value = ''
    try {
      const page = await requestPage({ before: before.value })
      if (run !== epoch || request !== historyRun) return
      before.value = page.nextCursor
      ingest(page.messages, 'older')
    } catch (error) {
      if (run === epoch && request === historyRun) historyError.value = getHttpErrorMessage(error, 'Не удалось загрузить историю')
    } finally {
      if (run === epoch && request === historyRun) { loading.value = false; if (syncAgain) { syncAgain = false; void syncHistory() } }
    }
  }
  async function syncHistory(from?: string) {
    if (!visible.value) return
    if (loading.value) { syncAgain = true; return }
    if (!newest) { if (opened.value) await loadLatest(); return }
    const run = epoch
    const request = ++historyRun
    const cursor = from || newest.id
    loading.value = true
    try {
      let after: string | null = cursor
      // Bounded catch-up. Subsequent pages continue on the next explicit open.
      for (let pageIndex = 0; after && pageIndex < 6; pageIndex++) {
        const page = await requestPage({ after })
        if (run !== epoch || request !== historyRun) return
        ingest(page.messages, 'history')
        after = page.nextCursor
      }
      historyError.value = ''
    } catch (error) {
      if (run === epoch && request === historyRun) historyError.value = getHttpErrorMessage(error, 'Не удалось обновить историю. Откройте чат и повторите.')
    } finally {
      if (run === epoch && request === historyRun) { loading.value = false; if (syncAgain) { syncAgain = false; void syncHistory() } }
    }
  }
  async function open() {
    // A fresh open supersedes background history requests, but never a send.
    historyRun++
    clearTimeout(deletionTimer)
    loading.value = false
    syncAgain = false
    opened.value = true
    loaded.value = false
    clearTimeout(toastTimer)
    toast.value = null
    firstUnread.value = messages.value.find(message => unread.value.has(message.id))?.id || null
    await loadLatest()
  }
  function close() { opened.value = false; showToast() }
  async function send(retry = false) {
    if (sending.value || readOnly.value) return
    if (!retry && pending.value) return
    if (!retry) {
      const text = draft.value.normalize('NFC').replace(/[\s\u200B-\u200D\uFEFF]+/gu, ' ').trim()
      if (!text || text.length > 300) return
      pending.value = { text, clientRequestId: crypto.randomUUID() }
      draft.value = ''
      persist()
    }
    if (!pending.value) return
    const attempt = { ...pending.value }
    const run = epoch
    sending.value = true
    sendError.value = ''
    try {
      if (!navigator.onLine) throw new Error('Нет сети. Сообщение не отправлено.')
      const credential = token()
      const result = await $fetch<{ message: RoomChatMessage }>(`/api/rooms/${encodeURIComponent(code.value)}/chat`, {
        method: 'POST', retry: 0, timeout: 15000,
        body: { message: attempt.text, clientRequestId: attempt.clientRequestId,
          ...(role.value === 'dealer' ? { dealerSecret: credential } : { participantId: session.participantId, token: credential }) }
      })
      if (run !== epoch) return
      ingest([result.message], 'send')
      pending.value = null
      persist()
    } catch (error) {
      if (run === epoch && pending.value) sendError.value = getHttpErrorMessage(error, 'Ответ не получен. Повторите отправку с тем же ключом.')
    } finally { if (run === epoch) sending.value = false }
  }
  function visibilityChanged() {
    visible.value = document.visibilityState === 'visible'
    if (visible.value) { void syncHistory(); showToast() }
    else {
      clearTimeout(toastTimer)
      // A displayed toast is already receipted; do not replay it on return.
      toast.value = null
    }
  }
  function online() { void syncHistory() }
  function reset() {
    epoch++
    clearTimeout(toastTimer)
    historyRun++
    messages.value = []; seen.value = new Set(); unread.value = new Set(); notified.clear(); deleted.clear()
    queue = []; toast.value = null; pending.value = null; sendError.value = ''; historyError.value = ''; draft.value = ''
    opened.value = false; loaded.value = false; loading.value = false; sending.value = false; before.value = null
    initialSnapshot = true; lastSnapshot = []; newest = undefined; notificationFloor = undefined; syncAgain = false
    restore()
  }
  watch(storageKey, () => { if (mounted) reset() })
  watch(() => room.chatMessages, rows => {
    if (!mounted || room.room?.code !== code.value) return
    const sorted = [...rows].sort(chatOrder)
    const priorNewest = newest
    if (initialSnapshot) {
      // Initial old snapshots establish notification baseline, not read receipts.
      if (!notificationFloor && sorted.length) notificationFloor = sorted.at(-1)
      initialSnapshot = false
    } else {
      const ids = new Set(rows.map(message => message.id))
      const first = sorted[0]
      for (const previous of lastSnapshot) {
        if (!ids.has(previous.id) && (!first || chatOrder(previous, first) >= 0)) removeMessage(previous.id)
      }
    }
    lastSnapshot = sorted
    ingest(rows, 'snapshot')
    clearTimeout(deletionTimer)
    deletionTimer = setTimeout(() => void checkOlderDeletions(), 500)
    if (priorNewest && sorted[0] && chatOrder(sorted[0], priorNewest) > 0) void syncHistory(priorNewest.id)
    persist()
  }, { deep: true })
  watch(() => room.connectionStatus, (value, previous) => {
    if (mounted && value === 'connected' && previous !== 'connected') void syncHistory()
  })
  watch(() => room.room?.revision, value => {
    if (mounted && opened.value && value !== undefined) void syncHistory()
  })
  onMounted(() => {
    mounted = true
    reset()
    visible.value = document.visibilityState === 'visible'
    if (room.room?.code === code.value) {
      notificationFloor ||= [...room.chatMessages].sort(chatOrder).at(-1)
      initialSnapshot = false
      lastSnapshot = [...room.chatMessages]
      ingest(room.chatMessages, 'snapshot')
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('online', online)
    window.addEventListener('pageshow', online)
  })
  onBeforeUnmount(() => {
    epoch++
    clearTimeout(toastTimer)
    clearTimeout(deletionTimer)
    document.removeEventListener('visibilitychange', visibilityChanged)
    window.removeEventListener('online', online)
    window.removeEventListener('pageshow', online)
  })
  return { messages, opened, loaded, loading, historyError, sendError, draft, pending, sending, before, firstUnread,
    toast, unreadCount, readOnly, isOwn, markSeen, open, close, loadLatest, loadOlder, send, toastShown, finishToast }
}
