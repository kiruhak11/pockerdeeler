<script setup lang="ts">
import { getHttpErrorMessage } from '~/utils/httpError'

type OnlineLobbyRoom = Readonly<{
  code: string
  playerCount: number
  maxPlayers: 6
  status: 'WAITING' | 'IN_HAND'
  createdAt: string
}>

const tab = ref<'open' | 'closed'>('open')
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
      <div><span class="online-lobby__eyebrow">ONLINE</span><h2 id="online-lobby-title">Онлайн-столы</h2><p class="page-subtitle">Публичные столы доступны всем игрокам после входа.</p></div>
      <button class="online-lobby__refresh" type="button" aria-label="Обновить онлайн-столы" :disabled="loading" @click="refresh">↻</button>
    </header>
    <div class="online-lobby__tabs" aria-label="Доступ к онлайн-комнатам">
      <button type="button" :class="{ active: tab === 'open' }" :aria-pressed="tab === 'open'" @click="tab = 'open'">Открытые</button>
      <button type="button" :class="{ active: tab === 'closed' }" :aria-pressed="tab === 'closed'" @click="tab = 'closed'">Закрытые</button>
    </div>
    <p v-if="error" class="online-lobby__error" role="alert">{{ error }}</p>
    <template v-else-if="tab === 'open'">
      <p v-if="loading && !rooms.length" class="page-subtitle">Ищем онлайн-столы…</p>
      <p v-else-if="!rooms.length" class="page-subtitle">Публичных онлайн-столов пока нет. Создайте свой и пригласите друзей.</p>
      <div v-else class="online-lobby__grid">
        <article v-for="room in rooms" :key="room.code" class="online-lobby__card">
          <div class="online-lobby__card-top"><span :class="{ live: room.status === 'IN_HAND' }"><i />{{ room.status === 'IN_HAND' ? 'Игра идёт' : 'Сбор игроков' }}</span><strong>{{ room.code }}</strong></div>
          <p>{{ room.playerCount }}/{{ room.maxPlayers }} игроков</p>
          <NuxtLink class="btn" :to="`/online/${room.code}`">Войти</NuxtLink>
        </article>
      </div>
    </template>
    <p v-else class="page-subtitle">Закрытые онлайн-комнаты доступны по коду. Введите код на главной странице или откройте приглашение.</p>
  </section>
</template>

<style scoped lang="scss">
.online-lobby { display: grid; gap: 1rem; }
.online-lobby__header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.online-lobby__eyebrow { color: var(--accent); font-size: .7rem; font-weight: 900; letter-spacing: .16em; }
.online-lobby h2 { margin: .25rem 0 0; }
.online-lobby__refresh { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; color: var(--text-primary); background: rgba(255,255,255,.04); font-size: 1.4rem; cursor: pointer; }
.online-lobby__tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; padding: .3rem; border-radius: 18px; background: rgba(0,0,0,.2); }
.online-lobby__tabs button { min-height: 44px; border: 1px solid transparent; border-radius: 14px; color: var(--text-muted); background: transparent; cursor: pointer; }
.online-lobby__tabs button.active { border-color: rgba(242,180,81,.3); color: var(--text-primary); background: rgba(242,180,81,.11); }
.online-lobby__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .75rem; }
.online-lobby__card { display: grid; gap: .8rem; padding: 1rem; border: 1px solid rgba(102,190,255,.24); border-radius: 18px; background: linear-gradient(145deg, #173b46, #10252e); }
.online-lobby__card-top { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.online-lobby__card-top span { display: inline-flex; align-items: center; gap: .4rem; color: var(--text-muted); font-size: .72rem; }
.online-lobby__card-top span i { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.online-lobby__card-top span.live i { background: var(--accent); }
.online-lobby__card-top strong { color: var(--accent); letter-spacing: .12em; }
.online-lobby__card p { margin: 0; color: var(--text-muted); }
.online-lobby__error { margin: 0; color: var(--danger); }
@media (max-width: 600px) { .online-lobby { padding: .8rem; } .online-lobby__header { align-items: flex-start; } .online-lobby__card .btn { width: 100%; } }
</style>
