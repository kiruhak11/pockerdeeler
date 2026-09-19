import { useGameStore } from '~/stores/game'
import { useRoomStore } from '~/stores/room'

export function usePwaSafety() {
  const route = useRoute()
  const local = useGameStore()
  const room = useRoomStore()
  const { state } = usePwa()
  const handBusy = computed(() => Boolean(
    local.game?.handActive || local.game?.handStage === 'showdown'
    || (room.currentHand && room.currentHand.status !== 'finished')
  ))
  // Unknown/disconnected room snapshots cannot establish that a hand is safe.
  const roomScreen = computed(() => /^\/room(?:\/|$)/.test(route.path))
  const safeToPrompt = computed(() => state.value.ready && state.value.visible && local.hydrated && !handBusy.value
    && (!roomScreen.value || /\/join\/?$/.test(route.path)) && !/^\/(?:admin|auth)(?:\/|$)/.test(route.path)
    && route.path !== '/game')
  const safeToUpdate = computed(() => safeToPrompt.value && !roomScreen.value && route.path !== '/setup' && state.value.online)
  return { handBusy, safeToPrompt, safeToUpdate }
}
