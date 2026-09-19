<script setup lang="ts">
import { streetNames } from '~/utils/bettingRounds'
import { useRoomStore } from '~/stores/room'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { getHttpErrorMessage } from '~/utils/httpError'
const props = defineProps<{ dealer?: boolean }>()
const room = useRoomStore()
const session = usePlayerSessionStore()
const { preferences, editablePreferences, save: savePreferences } = useGamePreferences()
const round = computed(() => room.currentHand?.bettingState)
const busy = ref(false)
const dialog = ref<HTMLDialogElement | null>(null)
const modalOpenedStreet = ref<string | null>(null)
let dismissTimer: ReturnType<typeof setTimeout> | undefined
const revealCount = computed(() => round.value?.street === 'preflop' ? 3 : 1)
function closeModal() {
  if (dismissTimer) clearTimeout(dismissTimer)
  dialog.value?.close()
}
async function openModal(openedStreet: string | null = null, force = false) {
  if (!force && !preferences.revealModals) return
  if (dismissTimer) clearTimeout(dismissTimer)
  modalOpenedStreet.value = openedStreet
  await nextTick()
  if (!dialog.value?.open) dialog.value?.showModal()
  if (openedStreet) dismissTimer = setTimeout(closeModal, 3000)
}
// Revisions from bets/presence must not reopen a dismissed notice. The event
// identity is the hand and street transition, including consecutive all-in reveals.
watch(() => `${room.currentHand?.id}:${room.currentHand?.status}:${round.value?.street}:${round.value?.phase}`, async (_key, previous) => {
  if (room.currentHand?.status !== 'active' || !round.value) { closeModal(); return }
  const old = previous?.split(':')
  const sameHand = old?.[0] === room.currentHand.id
  if (round.value.phase === 'reveal') await openModal()
  else if (sameHand && old?.[2] !== round.value.street && round.value.street !== 'preflop') await openModal(streetNames[round.value.street])
  else closeModal()
}, { flush: 'post' })
onMounted(() => { if (round.value?.phase === 'reveal' && room.currentHand?.status === 'active') void openModal() })
onBeforeUnmount(closeModal)
function disableRevealModals() {
  editablePreferences.revealModals = false
  savePreferences()
  closeModal()
}
const title = computed(() => {
  if (!round.value) return ''
  if (round.value.phase === 'showdown') return 'Торговля завершена. Определите победителей'
  if (round.value.phase === 'reveal') return round.value.street === 'preflop' ? 'Откройте флоп: 3 общие карты' : round.value.street === 'flop' ? 'Откройте тёрн: ещё 1 карту' : 'Откройте ривер: ещё 1 карту'
  return `${streetNames[round.value.street]}: круг ставок`
})
async function confirmCards() {
  if (busy.value || !room.currentHand || !round.value) return
  busy.value = true
  try {
    const result = await $fetch(`/api/rooms/${room.room?.code}/reveal-cards`, { method: 'POST', body: { dealerSecret: session.dealerSecret, handId: room.currentHand.id, street: round.value.street } })
    room.setRoomState(result.state)
  } catch (error) { room.setError(getHttpErrorMessage(error, 'Не удалось открыть следующий раунд')) }
  finally { busy.value = false }
}
</script>

<template>
  <section v-if="round && room.currentHand?.status === 'active'" class="panel betting-notice" :class="{ 'betting-notice--reveal': round.phase === 'reveal' }" role="status" aria-live="polite">
    <span class="tag">{{ streetNames[round.street] }}</span>
    <h2>{{ title }}</h2>
    <template v-if="round.phase === 'reveal'">
      <p>Все ставки уравнены. Перед открытием сожгите одну карту. Банк сохраняется, ставки нового круга начинаются с нуля.</p>
      <button class="btn" :disabled="busy" @click="openModal(null, true)">{{ props.dealer ? 'Открыть общие карты' : 'Показать подсказку об открытии' }}</button>
      <p v-if="!props.dealer">Ожидаем открытия карт и подтверждения дилера.</p>
    </template>
    <p v-else-if="round.phase === 'betting'">{{ room.players.find(p => p.id === room.currentSession?.currentPlayerId)?.name || 'Ожидаем игрока' }} делает ход.</p>
  </section>
  <Teleport to="body">
    <dialog ref="dialog" class="reveal-dialog" aria-labelledby="reveal-title" aria-describedby="reveal-description" @click="event => { if (event.target === dialog) closeModal() }" @cancel="closeModal">
      <div class="reveal-dialog__content">
        <span class="tag">Раздача №{{ room.currentHand?.handNumber }} · Общие карты</span>
        <template v-if="modalOpenedStreet">
          <h2 id="reveal-title">{{ modalOpenedStreet }} открыт</h2>
          <p id="reveal-description">{{ round?.phase === 'showdown' ? 'Все карты на столе. Ожидаем определения победителей.' : 'Начался новый круг ставок. Следите за подсказкой, чей сейчас ход.' }}</p>
          <p>Эта подсказка закроется через 3 секунды.</p>
        </template>
        <template v-else>
          <div class="reveal-dialog__cards" aria-hidden="true"><span v-for="card in revealCount" :key="card">{{ card }}</span></div>
          <h2 id="reveal-title">{{ props.dealer ? title : title.replace('Откройте', 'Дилер открывает') }}</h2>
          <p id="reveal-description">{{ props.dealer ? 'Сожгите одну карту, затем выложите общие карты на реальный стол. Только после этого подтвердите открытие.' : 'Круг ставок завершён. Подождите, пока дилер выложит карты на стол и подтвердит открытие.' }}</p>
          <p>Прогнозы не задерживают игру. Банк остаётся на столе.</p>
          <button v-if="props.dealer" class="btn" :disabled="busy" @click="confirmCards">{{ busy ? 'Подтверждаем...' : 'Карты открыты, продолжить' }}</button>
        </template>
        <button class="btn btn--ghost" :disabled="busy" @click="closeModal">{{ props.dealer && !modalOpenedStreet ? 'Позже' : 'Понятно' }}</button>
        <button v-if="modalOpenedStreet" class="reveal-dialog__never" type="button" @click="disableRevealModals">Больше не показывать автоматически</button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped lang="scss">
.betting-notice { display: grid; gap: 0.7rem; h2, p { margin: 0; } p { color: var(--text-muted); } .tag, button { justify-self: start; } &--reveal { border: 1px solid var(--accent); background: linear-gradient(120deg, #3d3920, #183323); } }
.reveal-dialog {
  width: min(480px, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); margin: auto; padding: 0;
  color: var(--text); background: radial-gradient(ellipse at top, #284b34, #10251b 70%);
  border: 1px solid #9e9852; border-radius: var(--radius-lg); box-shadow: 0 24px 80px #0009;
  &::backdrop { background: #030d0bd4; backdrop-filter: blur(5px); }
  &__content { padding: clamp(1.2rem, 5vw, 2rem); display: grid; gap: 1rem; h2, p { margin: 0; } p { line-height: 1.55; color: var(--text-muted); } .btn { min-height: 48px; } }
  &__cards { display: flex; justify-content: center; gap: 0.65rem; padding: 0.5rem; span { display: grid; place-items: center; width: 54px; height: 76px; border: 2px solid #decf9c; border-radius: 7px; color: #decf9c; background: repeating-linear-gradient(45deg, #1c4a36, #1c4a36 4px, #234e3b 4px, #234e3b 8px); font-size: 1.4rem; } }
  &__never { border: 0; color: var(--text-muted); background: transparent; text-decoration: underline; cursor: pointer; }
}
</style>
