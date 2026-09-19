import { useAccountStore } from '~/stores/account'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { usePredictionStore } from '~/stores/prediction'
import { createClientRequestId } from '~/utils/idempotency'

export function usePredictions(roomCode: MaybeRefOrGetter<string>) {
  const account = useAccountStore()
  const session = usePlayerSessionStore()
  const prediction = usePredictionStore()
  const code = computed(() => toValue(roomCode).trim().toUpperCase())

  async function refreshViewer() {
    if (!account.token) { prediction.setViewer(null); return null }
    const state = await $fetch(`/api/rooms/${code.value}/predictions/current`, { headers: { Authorization: `Bearer ${account.token}` } })
    prediction.setViewer(state)
    return state
  }

  async function refreshDealer() {
    if (!session.dealerSecret) { prediction.setDealer(null); return null }
    const state = await $fetch(`/api/rooms/${code.value}/predictions/dealer`, { headers: { Authorization: `Bearer ${session.dealerSecret}` } })
    prediction.setDealer(state)
    return state
  }

  async function placeBet(candidatePlayerId: string, stake: number, expectedMarketRevision: number) {
    const viewer = prediction.viewer
    const market = viewer?.currentMarket
    if (!account.token || !viewer?.memberId || !market) throw new Error('Рынок прогнозов недоступен')
    const result = await $fetch(`/api/rooms/${code.value}/predictions/${market.id}/bet`, {
      method: 'POST',
      body: {
        accountToken: account.token,
        memberId: viewer.memberId,
        candidatePlayerId,
        stake,
        clientRequestId: createClientRequestId('prediction'),
        expectedMarketRevision
      }
    })
    prediction.setViewer(result.state)
    return result
  }

  async function requestReentry(amount: number) {
    const viewer = prediction.viewer
    if (!account.token || !viewer?.memberId) throw new Error('Возврат недоступен')
    const result = await $fetch(`/api/rooms/${code.value}/reentries/request`, {
      method: 'POST',
      body: { accountToken: account.token, memberId: viewer.memberId, amount, clientRequestId: createClientRequestId('reentry') }
    })
    prediction.setViewer(result.state)
    return result
  }

  async function decideReentry(requestId: string, decision: 'approve' | 'reject') {
    if (!session.dealerSecret) throw new Error('Сессия дилера не найдена')
    await $fetch(`/api/rooms/${code.value}/reentries/${requestId}/decision`, {
      method: 'POST', body: { dealerSecret: session.dealerSecret, decision }
    })
    return refreshDealer()
  }

  async function decideEntry(memberId: string, decision: 'approve' | 'reject', rebindMemberId?: string) {
    if (!session.dealerSecret) throw new Error('Сессия дилера не найдена')
    await $fetch(`/api/rooms/${code.value}/members/${memberId}/decision`, {
      method: 'POST', body: { dealerSecret: session.dealerSecret, decision, rebindMemberId }
    })
    return refreshDealer()
  }

  async function voidMarket(marketId: string, reason: string) {
    if (!session.dealerSecret) throw new Error('Сессия дилера не найдена')
    await $fetch(`/api/rooms/${code.value}/predictions/${marketId}/void`, {
      method: 'POST', body: { dealerSecret: session.dealerSecret, reason }
    })
    return refreshDealer()
  }

  return { refreshViewer, refreshDealer, placeBet, requestReentry, decideReentry, decideEntry, voidMarket }
}
