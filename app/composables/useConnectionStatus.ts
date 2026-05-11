import { useRoomStore } from "~/stores/room"

export function useConnectionStatus() {
  const roomStore = useRoomStore()
  return computed(() => roomStore.connectionStatus)
}
