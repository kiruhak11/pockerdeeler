import { useAccountStore } from '~/stores/account'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { useRoomStore } from '~/stores/room'

export function useReservedRoom() {
  const account = useAccountStore()
  const session = usePlayerSessionStore()
  const room = useRoomStore()
  async function resume(code: string) {
    if (!account.token) throw new Error('Войдите в аккаунт')
    const result = await $fetch(`/api/rooms/${code}/resume`, { method: 'POST', body: { token: account.token } })
    session.saveSession({ roomCode: code, playerId: result.playerId, participantId: result.participantId,
      role: 'player', token: result.playerSessionToken, dealerSecret: null })
    room.setRoomState(result.state)
    return result
  }
  async function release(code: string) {
    if (!account.token) throw new Error('Войдите в аккаунт')
    await $fetch(`/api/rooms/${code}/leave`, { method: 'POST', body: { authToken: account.token } })
    if (session.roomCode === code && session.role === 'player') { session.clearSession(); room.resetRoom() }
  }
  return { resume, release }
}
