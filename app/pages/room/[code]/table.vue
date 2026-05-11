<script setup lang="ts">
import { useRoomStore } from "~/stores/room"

import ConnectionStatus from '~/components/room/ConnectionStatus.vue'
import GamePotSummary from '~/components/game/PotSummary.vue'
import TablePlayers from '~/components/game/TablePlayers.vue'
import ActionHistory from '~/components/game/ActionHistory.vue'

const route = useRoute()
const roomStore = useRoomStore()

const code = computed(() => String(route.params.code || '').toUpperCase())
useRoomRealtime(code)

onMounted(async () => {
  const state = await $fetch(`/api/rooms/${code.value}/state`)
  roomStore.setRoomState(state)
})
</script>

<template>
  <main class="page-shell table-room-page">
    <header>
      <h1 class="page-title">Общий стол · {{ code }}</h1>
      <ConnectionStatus :status="roomStore.connectionStatus" />
    </header>

    <GamePotSummary
      :pot="roomStore.currentHand?.pot || 0"
      :current-bet="roomStore.currentHand?.currentBet || 0"
      :hand-number="roomStore.currentHand?.handNumber || 0"
    />

    <TablePlayers :players="roomStore.players" />
    <ActionHistory :actions="roomStore.actions.slice(-15)" />
  </main>
</template>

<style scoped lang="scss">
.table-room-page {
  display: grid;
  gap: 0.85rem;
  padding-block: 1rem 2rem;

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
  }
}
</style>
