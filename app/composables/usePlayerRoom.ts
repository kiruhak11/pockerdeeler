import { createClientRequestId } from '~/utils/idempotency'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { useRoomStore } from '~/stores/room'
import type { BuyInOptionsView, RoomState } from '~/types/room'
import { useAccountStore } from '~/stores/account'

export function usePlayerRoom(roomCode: MaybeRefOrGetter<string | undefined>) {
  const sessionStore = usePlayerSessionStore()
  const roomStore = useRoomStore()
  const credentials = useRoomCredentials()
  const accountStore = useAccountStore()

  const code = computed(() => toValue(roomCode)?.trim().toUpperCase())

  async function joinRoom(payload: { name: string; role?: 'player' | 'spectator'; authToken?: string; password?: string; buyInAmount?: number; clientRequestId?: string }) {
    const currentCode = code.value
    if (!currentCode) {
      throw new Error('Код комнаты отсутствует')
    }

    return $fetch(`/api/rooms/${currentCode}/join`, {
      method: 'POST',
      body: payload
    })
  }

  type Command = import('~/types/realtime').UncertainPlayerAction
  type ActionResponse = { success: boolean; state?: RoomState; action?: { status: 'pending' | 'approved' | 'rejected' | 'applied' } }
  let mounted = false
  let checking = false
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let recoveryAttempts = 0
  const storageKey = (room: string, player: string) => 'poker-uncertain-action-v1:' + room + ':' + player

  function restoreUncertainAction() {
    if (!code.value || !sessionStore.playerId || typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(storageKey(code.value, sessionStore.playerId))
      const saved = raw ? JSON.parse(raw) as Command : null
      roomStore.uncertainAction = saved?.roomCode === code.value && saved.playerId === sessionStore.playerId
        && typeof saved.clientRequestId === 'string' && typeof saved.handId === 'string' && Number.isSafeInteger(saved.expectedRevision) ? saved : null
    } catch { /* Sending requires durable storage below. */ }
  }

  function clearUncertainAction(command: Command) {
    try {
      const key = storageKey(command.roomCode, command.playerId)
      const saved = JSON.parse(localStorage.getItem(key) || 'null') as Command | null
      if (saved?.clientRequestId === command.clientRequestId) localStorage.removeItem(key)
    } catch { /* A later reload can query the persisted command again. */ }
    if (roomStore.uncertainAction?.clientRequestId === command.clientRequestId) roomStore.uncertainAction = null
  }

  async function recoverAction() {
    const command = roomStore.uncertainAction
    if (!mounted || !command || checking || roomStore.actionBusy || !roomStore.isStateFresh || !sessionStore.token) return
    checking = true
    clearTimeout(recoveryTimer)
    try {
      const result = await $fetch<{ action: ActionResponse['action'] | null; checkedRevision: number; state: RoomState }>(
        `/api/rooms/${command.roomCode}/action-status`, {
          headers: { Authorization: `Bearer ${sessionStore.token}` },
          query: { playerId: command.playerId, clientRequestId: command.clientRequestId }, timeout: 12_000, retry: 0
        })
      if (!mounted || code.value !== command.roomCode || sessionStore.playerId !== command.playerId) return
      roomStore.setRoomState(result.state)
      if (result.action) {
        clearUncertainAction(command)
        roomStore.recoveryMessage = result.action.status === 'pending' ? 'Действие принято. Ждём дилера.'
          : result.action.status === 'rejected' ? 'Дилер отклонил действие.' : 'Действие принято. Повторная ставка не отправлялась.'
      } else if (result.checkedRevision > command.expectedRevision) {
        // A locked read proved the ID absent after its version expired. A delayed
        // original POST now fails stale validation, so it is safe to allow a new one.
        clearUncertainAction(command)
        roomStore.recoveryMessage = 'Ставка не принята, игра уже изменилась. Выберите действие заново.'
      } else {
        roomStore.recoveryMessage = 'Результат ставки пока неизвестен. Проверяем без повторной отправки.'
      }
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number }).statusCode || (error as { status?: number }).status
      if ([401, 403, 404].includes(status || 0)) roomStore.setConnectionStatus('unauthorized')
      roomStore.recoveryMessage = 'Не удалось проверить ставку. Не отправляйте её заново.'
    } finally {
      checking = false
      if (mounted && roomStore.uncertainAction && roomStore.isStateFresh && recoveryAttempts++ < 5) {
        recoveryTimer = setTimeout(() => void recoverAction(), Math.min(15_000, 1000 * 2 ** recoveryAttempts))
      }
    }
  }

  async function sendAction(payload: { type: Command['type']; amount: number }) {
    const currentCode = code.value
    if (!currentCode || sessionStore.roomCode !== currentCode || !sessionStore.playerId || !sessionStore.token) throw new Error('Сессия игрока не найдена')
    restoreUncertainAction()
    if (roomStore.actionBusy || roomStore.uncertainAction) throw new Error('Проверяем предыдущее действие. Не отправляйте ставку повторно.')
    if (!roomStore.isStateFresh || roomStore.room?.code !== currentCode || !roomStore.currentHand || roomStore.currentHand.status !== 'active') {
      throw new Error('Обновляем игру. Дождитесь синхронизации стола.')
    }
    if (roomStore.pendingActions.some(action => action.playerId === sessionStore.playerId)) throw new Error('Ожидаем подтверждения дилера')
    const command: Command = {
      roomCode: currentCode, playerId: sessionStore.playerId, ...payload,
      clientRequestId: createClientRequestId('action'), handId: roomStore.currentHand.id, expectedRevision: roomStore.room.revision
    }
    try { localStorage.setItem(storageKey(currentCode, command.playerId), JSON.stringify(command)) }
    catch { throw new Error('Разрешите локальное хранилище: без него нельзя безопасно восстановить результат ставки.') }
    roomStore.uncertainAction = command
    roomStore.actionBusy = true
    roomStore.recoveryMessage = null
    return deliverAction(command)
  }

  async function deliverAction(command: Command) {
    roomStore.actionBusy = true
    try {
      const response = await $fetch<ActionResponse>(`/api/rooms/${command.roomCode}/action`, {
        method: 'POST', body: { ...command, token: sessionStore.token }, timeout: 12_000, retry: 0
      })
      if (!response.action || !response.success) throw new Error('Сервер не подтвердил действие')
      clearUncertainAction(command)
      if (response.state && code.value === command.roomCode) roomStore.setRoomState(response.state)
      return response
    } catch (error) {
      const status = (error as { statusCode?: number; status?: number }).statusCode || (error as { status?: number }).status
      if ([400, 401, 403, 404, 409, 422, 429].includes(status || 0)) clearUncertainAction(command)
      else roomStore.recoveryMessage = 'Ответ на ставку потерян. Проверяем результат, не отправляя её повторно.'
      roomStore.setConnectionStatus([401, 403, 404].includes(status || 0) ? 'unauthorized' : 'syncing')
      if (roomStore.connectionStatus !== 'unauthorized') roomStore.retryConnectionRequest++
      throw error
    } finally {
      roomStore.actionBusy = false
      recoveryAttempts = 0
      void recoverAction()
    }
  }

  async function retryUncertainAction() {
    const command = roomStore.uncertainAction
    if (!command || roomStore.actionBusy || checking || !roomStore.isStateFresh || navigator.onLine === false) return
    if (command.handId !== roomStore.currentHand?.id || command.expectedRevision !== roomStore.room?.revision) {
      await recoverAction()
      return
    }
    // Explicit user retry only, using the ORIGINAL ID and version, never an offline queue.
    await deliverAction(command).catch(() => undefined)
  }

  function storageChanged(event: StorageEvent) {
    if (code.value && sessionStore.playerId && event.key === storageKey(code.value, sessionStore.playerId)) {
      restoreUncertainAction()
      void recoverAction()
    }
  }
  watch([() => roomStore.isStateFresh, () => roomStore.room?.revision, () => roomStore.retryActionRequest], () => {
    recoveryAttempts = 0
    void recoverAction()
  })
  watch(() => [code.value, sessionStore.playerId], () => { if (mounted) { restoreUncertainAction(); void recoverAction() } })
  watch(() => roomStore.retryActionDeliveryRequest, () => void retryUncertainAction())
  onMounted(() => {
    mounted = true
    restoreUncertainAction()
    window.addEventListener('storage', storageChanged)
    void recoverAction()
  })
  onBeforeUnmount(() => {
    mounted = false
    clearTimeout(recoveryTimer)
    window.removeEventListener('storage', storageChanged)
  })

  async function fetchState() {
    const currentCode = code.value
    if (!currentCode) {
      return
    }

    const state = await $fetch(`/api/rooms/${currentCode}/state`, { headers: credentials.headers(currentCode) })
    roomStore.setRoomState(state)
  }

  async function leaveRoom() {
    const currentCode = code.value
    if (!currentCode || !sessionStore.participantId || !sessionStore.token) {
      return
    }

    await $fetch(`/api/rooms/${currentCode}/leave`, {
      method: 'POST',
      body: {
        participantId: sessionStore.participantId,
        playerId: sessionStore.playerId,
        token: sessionStore.token
      }
    })
  }

  async function getBuyInOptions(): Promise<BuyInOptionsView | null> {
    const currentCode = code.value
    if (!currentCode || !accountStore.token) return null
    return $fetch<BuyInOptionsView>(`/api/rooms/${currentCode}/buy-in-options`, {
      headers: { Authorization: `Bearer ${accountStore.token}` }
    })
  }

  async function topUp(memberId: string, amount: number) {
    const currentCode = code.value
    if (!currentCode || !accountStore.token) throw new Error('Сессия аккаунта не найдена')
    const response = await $fetch<{ success: boolean; state: RoomState }>(`/api/rooms/${currentCode}/top-up`, {
      method: 'POST',
      body: {
        accountToken: accountStore.token,
        memberId,
        amount,
        clientRequestId: createClientRequestId('topup')
      }
    })
    roomStore.setRoomState(response.state)
    return response
  }

  async function returnStack(memberId: string, amount: number) {
    const currentCode = code.value
    if (!currentCode || !accountStore.token) throw new Error('Сессия аккаунта не найдена')
    const response = await $fetch<{ success: boolean; state: RoomState }>(`/api/rooms/${currentCode}/return-stack`, {
      method: 'POST', body: { accountToken: accountStore.token, memberId, amount, clientRequestId: createClientRequestId('stack-return') }
    })
    roomStore.setRoomState(response.state)
    return response
  }

  function reconnect() {
    return fetchState()
  }

  return {
    joinRoom,
    sendAction,
    recoverAction,
    retryUncertainAction,
    fetchState,
    leaveRoom,
    getBuyInOptions,
    topUp,
    returnStack,
    reconnect
  }
}
