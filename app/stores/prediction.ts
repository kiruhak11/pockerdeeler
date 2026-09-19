import type { DealerPredictionState, PredictionViewerState } from '~/types/prediction'

export const usePredictionStore = defineStore('prediction', {
  state: () => ({
    viewer: null as PredictionViewerState | null,
    dealer: null as DealerPredictionState | null,
    isLoading: false,
    error: null as string | null
  }),
  actions: {
    setViewer(state: PredictionViewerState | null) {
      if (state && this.viewer?.roomId === state.roomId && this.viewer.memberId === state.memberId && this.viewer.roomRevision > state.roomRevision) return
      this.viewer = state; this.error = null
    },
    setDealer(state: DealerPredictionState | null) {
      if (state && this.dealer?.roomId === state.roomId && this.dealer.roomRevision > state.roomRevision) return
      this.dealer = state; this.error = null
    },
    setError(message: string | null) { this.error = message },
    reset() { this.viewer = null; this.dealer = null; this.isLoading = false; this.error = null }
  }
})
