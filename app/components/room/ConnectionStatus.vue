<script setup lang="ts">
import type { ConnectionStatus } from '~/types/realtime'
import { useRoomStore } from '~/stores/room'
const props = defineProps<{ status: ConnectionStatus }>()
const roomStore = useRoomStore()
const labels: Record<ConnectionStatus, string> = {
  connected: 'Вы снова за столом', connecting: 'Подключаемся…', syncing: 'Обновляем игру…',
  disconnected: 'Нет связи', unauthorized: 'Требуется вход'
}
const label = computed(() => labels[props.status])
</script>

<template>
  <div class="connection-status" role="status" aria-live="polite">
    <span class="tag" :class="`conn conn--${status}`">{{ label }}</span>
    <button v-if="status === 'disconnected'" class="btn btn--ghost" type="button" @click="roomStore.retryConnectionRequest++">Повторить</button>
    <NuxtLink v-if="status === 'unauthorized'" class="btn btn--ghost" to="/rooms">К столам</NuxtLink>
  </div>
</template>

<style scoped lang="scss">
.connection-status { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.conn--connected { color: var(--success); }
.conn--disconnected, .conn--unauthorized { color: var(--danger); }
.conn--syncing, .conn--connecting { color: var(--accent-strong); }
</style>
