<script setup lang="ts">
import { getHttpErrorMessage } from '~/utils/httpError'

const props = withDefaults(defineProps<{ platformMode?: 'web' | 'yandex' }>(), { platformMode: 'web' })

type OnlineLobbyRoom = Readonly<{
  code: string
  visibility: 'PUBLIC' | 'PRIVATE'
  playerCount: number
  maxPlayers: 6
  spectatorCount?: number
  status: 'WAITING' | 'IN_HAND' | 'FULL'
  createdAt: string
  startingStack: number
  smallBlind: number
  bigBlind: number
}>

const rooms = ref<readonly OnlineLobbyRoom[]>([])
const loading = ref(false)
const error = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<{ rooms: readonly OnlineLobbyRoom[] }>('/api/online/rooms', { retry: 0 })
    rooms.value = result.rooms
  } catch (cause) {
    error.value = getHttpErrorMessage(cause, 'Не удалось загрузить онлайн-столы. Попробуйте обновить список.')
  } finally {
    loading.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section class="panel online-lobby" aria-labelledby="online-lobby-title">
    <header class="online-lobby__header">
      <div><span class="online-lobby__eyebrow">ONLINE</span><h2 id="online-lobby-title">Онлайн-столы</h2><p class="page-subtitle">Открытые публичные столы и приватные столы с входом по паролю.</p></div>
      <button class="online-lobby__refresh" type="button" aria-label="Обновить онлайн-столы" :disabled="loading" @click="refresh">↻</button>
    </header>
    <p v-if="error" class="online-lobby__error" role="alert">{{ error }}</p>
    <template v-else>
      <p v-if="loading && !rooms.length" class="page-subtitle">Ищем онлайн-столы…</p>
      <div v-else-if="!rooms.length" class="online-lobby__empty"><p>Сейчас нет доступных онлайн-столов</p><NuxtLink v-if="props.platformMode === 'web'" class="btn" to="/online/create">Создать онлайн-комнату</NuxtLink></div>
      <div v-else class="online-lobby__grid">
        <article v-for="room in rooms" :key="room.code" class="online-lobby__card">
          <div class="online-lobby__card-top"><span :class="{ live: room.status === 'IN_HAND', full: room.status === 'FULL' }"><i />{{ room.status === 'IN_HAND' ? 'Игра идёт' : room.status === 'FULL' ? 'Стол заполнен' : 'Ожидает игроков' }}</span><strong>{{ room.code }}</strong></div>
          <p class="online-lobby__visibility">{{ room.visibility === 'PRIVATE' ? '🔒 Приватная' : 'Публичная' }}</p>
          <p>{{ room.playerCount }}/{{ room.maxPlayers }} игроков<span v-if="room.spectatorCount !== undefined"> · {{ room.spectatorCount }} зрителей</span></p>
          <p class="online-lobby__settings">Стек {{ room.startingStack.toLocaleString('ru-RU') }} · Блайнды {{ room.smallBlind }}/{{ room.bigBlind }}</p>
          <div class="online-lobby__actions">
            <button v-if="props.platformMode === 'yandex'" class="btn" type="button" disabled>Подключение скоро</button>
            <NuxtLink v-else-if="room.visibility === 'PRIVATE'" class="btn" :to="`/online/${room.code}`">Ввести пароль</NuxtLink>
            <NuxtLink v-else-if="room.status === 'WAITING'" class="btn" :to="`/online/${room.code}?join=1`">Занять место</NuxtLink>
            <NuxtLink v-else class="btn" :to="`/online/${room.code}`">Смотреть</NuxtLink>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.online-lobby { display: grid; gap: 1rem; }
.online-lobby__header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.online-lobby__eyebrow { color: var(--accent); font-size: .7rem; font-weight: 900; letter-spacing: .16em; }
.online-lobby h2 { margin: .25rem 0 0; }
.online-lobby__refresh { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; color: var(--text-primary); background: rgba(255,255,255,.04); font-size: 1.4rem; cursor: pointer; }
.online-lobby__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .75rem; }
.online-lobby__card { display: grid; gap: .8rem; padding: 1rem; border: 1px solid rgba(102,190,255,.24); border-radius: 18px; background: linear-gradient(145deg, #173b46, #10252e); }
.online-lobby__card-top { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.online-lobby__card-top span { display: inline-flex; align-items: center; gap: .4rem; color: var(--text-muted); font-size: .72rem; }
.online-lobby__card-top span i { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.online-lobby__card-top span.live i { background: var(--accent); }
.online-lobby__card-top span.full i { background: var(--danger); }
.online-lobby__card-top strong { color: var(--accent); letter-spacing: .12em; }
.online-lobby__card p { margin: 0; color: var(--text-muted); }
.online-lobby__card .online-lobby__visibility { color: var(--text-primary); font-weight: 700; }
.online-lobby__card .online-lobby__settings { font-size: .82rem; }
.online-lobby__actions { display: grid; gap: .45rem; }
.online-lobby__empty { display: grid; justify-items: start; gap: .8rem; }
.online-lobby__empty p { margin: 0; color: var(--text-muted); }
.online-lobby__error { margin: 0; color: var(--danger); }
@media (max-width: 600px) { .online-lobby { padding: .8rem; } .online-lobby__header { align-items: flex-start; } .online-lobby__card .btn { width: 100%; } }
</style>
