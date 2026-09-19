import { usePlayerSessionStore } from '~/stores/playerSession'

export function useRoomCredentials() {
  const session = usePlayerSessionStore()
  function token(code: string) {
    session.loadSession()
    if (session.roomCode !== code) return ''
    return session.role === 'dealer' ? session.dealerSecret || '' : session.token || ''
  }
  function headers(code: string) { return { Authorization: `Bearer ${token(code)}` } }
  return { token, headers }
}
