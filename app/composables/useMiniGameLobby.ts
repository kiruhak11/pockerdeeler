export function useMiniGameLobby() {
  const data = ref<{ minesBank: number; rocketBank: number; jackpot: number; season: { number: number; endsAt: string } | null; participants: Array<{ userId: string; username: string; lost: number; games: number; chance: number }> } | null>(null)
  const error = ref(false)
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: ReturnType<typeof setInterval> | undefined
  let pending = false
  let disposed = false
  async function refresh() {
    if (pending || disposed) return
    pending = true
    try { const result = await $fetch<NonNullable<typeof data.value>>('/api/minigames/economy', { retry: 0 }); if (!disposed) { data.value = result; error.value = false } }
    catch { error.value = true }
    finally { pending = false }
  }
  const countdown = computed(() => {
    if (!data.value?.season) return 'Ожидаем следующий сезон'
    const seconds = Math.max(0, Math.floor((Date.parse(data.value.season.endsAt) - now.value) / 1000))
    if (!seconds) return 'Подведение итогов после перехода сезона'
    return `${Math.floor(seconds / 86400)}д ${String(Math.floor(seconds / 3600) % 24).padStart(2, '0')}ч ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}м ${String(seconds % 60).padStart(2, '0')}с`
  })
  function visible() { if (document.visibilityState === 'visible') void refresh() }
  onMounted(() => { void refresh(); timer = setInterval(visible, 3000); ticking = setInterval(() => { now.value = Date.now() }, 1000); document.addEventListener('visibilitychange', visible) })
  onBeforeUnmount(() => { disposed = true; clearInterval(timer); clearInterval(ticking); document.removeEventListener('visibilitychange', visible) })
  return { data, error, countdown, refresh }
}
