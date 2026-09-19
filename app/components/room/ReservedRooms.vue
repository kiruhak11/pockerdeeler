<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { getHttpErrorMessage } from '~/utils/httpError'

const account = useAccountStore(), session = usePlayerSessionStore()
const { resume, release } = useReservedRoom()
const rooms = ref<{ roomCode: string; name: string; stack: number; isAway: boolean }[]>([])
const busy = ref(false), error = ref(''), localRoom = ref<string | null>(null)
const localRoute = computed(() => session.role === 'dealer' ? 'dealer' : session.role === 'spectator' ? 'table' : 'player')

async function refresh() {
  error.value = ''
  const token = account.token
  if (!token) { rooms.value = []; return }
  try {
    const result = await $fetch('/api/auth/rooms', { method: 'POST', body: { token } })
    if (account.token === token) rooms.value = result
  } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось проверить сохранённые места') }
}
onMounted(async () => {
  account.loadSession(); session.loadSession()
  await refresh()
  if (session.roomCode) {
    try { localRoom.value = (await $fetch(`/api/rooms/${session.roomCode}/info`)).name }
    catch { localRoom.value = null }
  }
})
watch(() => account.token, () => { if (import.meta.client) void refresh() })
async function enter(code: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await resume(code); await navigateTo(`/room/${code}/player`) }
  catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось вернуться') }
  finally { busy.value = false }
}
async function leave(code: string) {
  if (busy.value || !confirm('Выйти полностью и освободить место? Внесённые ставки останутся в банке до расчёта раздачи.')) return
  busy.value = true; error.value = ''
  try { await release(code); localRoom.value = null; await refresh() }
  catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось выйти') }
  finally { busy.value = false }
}
</script>

<template>
  <section v-if="rooms.length || localRoom || error" class="panel reserved-rooms" aria-label="Мои места за столом">
    <h2>Ваше место за столом</h2>
    <p class="page-subtitle">Вернитесь с прежним стеком или освободите место. Отошедшие игроки пропускают новые раздачи.</p>
    <article v-for="room in rooms" :key="room.roomCode">
      <div><strong>{{ room.name }}</strong><p>{{ room.roomCode }} · Стек {{ room.stack.toLocaleString('ru-RU') }} · {{ room.isAway ? 'Место сохранено' : 'Вы за столом' }}</p></div>
      <div class="reserved-rooms__actions">
        <button class="btn" :disabled="busy" @click="enter(room.roomCode)">Вернуться к столу</button>
        <button class="btn btn--ghost" :disabled="busy" @click="leave(room.roomCode)">Выйти полностью</button>
      </div>
    </article>
    <article v-if="localRoom && session.roomCode && !rooms.some(r => r.roomCode === session.roomCode)">
      <strong>{{ localRoom }}</strong>
      <NuxtLink class="btn btn--ghost" :to="`/room/${session.roomCode}/${localRoute}`">{{ session.role === 'dealer' ? 'Вернуться к управлению' : 'Продолжить в этом браузере' }}</NuxtLink>
    </article>
    <p v-if="error" role="alert">{{ error }} <button class="btn btn--ghost" @click="refresh">Повторить</button></p>
  </section>
</template>

<style scoped lang="scss">
.reserved-rooms {
  width: 100%; display: grid; gap: 0.9rem; border-color: rgba(242, 180, 81, 0.3); text-align: left;
  h2, p { margin: 0; } h2 { font-size: 1.15rem; }
  article { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.8rem; align-items: center; }
  article p { color: var(--text-muted); font-size: 0.85rem; margin-top: 0.3rem; }
  &__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
}
</style>
