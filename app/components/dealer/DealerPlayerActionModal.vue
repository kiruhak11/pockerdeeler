<script setup lang="ts">
import type { PlayerActionType } from '~/types/game'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'

const props = defineProps<{
  visible: boolean
  playerName: string
  playerStack: number
  playerStatus?: string
  canAct: boolean
  tableRating?: number
  predictionRating?: number
  achievementCount?: number
  achievementIcons?: string[]
}>()

const emit = defineEmits<{
  close: []
  forceAction: [payload: { type: PlayerActionType; amount: number }]
  kick: []
}>()

const amount = ref(0)
const { preferences } = useGamePreferences()
const actionLabels = computed(() => preferences.actionLanguage === 'ru'
  ? { check: 'Чек', call: 'Поддержать', bet: 'Поставить', raise: 'Повысить', fold: 'Сбросить', allIn: 'Ва-банк' }
  : { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', fold: 'Fold', allIn: 'All-in' })

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      amount.value = 0
    }
  }
)

function submit(type: PlayerActionType) {
  if (!props.canAct) return
  emit('forceAction', {
    type,
    amount: Math.max(0, Math.trunc(amount.value || 0))
  })
}
</script>

<template>
  <Teleport to="body">
    <transition name="dealer-action-fade">
      <div v-if="visible" class="dealer-player-action-modal">
        <div class="dealer-player-action-modal__card">
          <header>
            <h3>{{ playerName }}</h3>
            <button type="button" class="btn btn--ghost" @click="emit('close')">Закрыть</button>
          </header>

          <p>Стек игрока: {{ playerStack }} · Статус: {{ playerStatus || '—' }}</p>
          <div class="dealer-player-action-modal__profile"><span>Игра <strong>{{ tableRating || '—' }}</strong></span><span>Прогнозы <strong>{{ predictionRating || '—' }}</strong></span><span>Достижения <strong>{{ achievementCount || 0 }}</strong></span></div>
          <div v-if="achievementIcons?.length" class="dealer-player-action-modal__icons"><span v-for="(icon, index) in achievementIcons" :key="`${icon}-${index}`"><AchievementBadge :code="icon" :size="26"/></span></div>

          <label>
            <span>Сумма</span>
            <input v-model.number="amount" class="input" type="number" min="0">
          </label>

          <p v-if="!canAct">Сейчас не ход этого игрока. Можно удалить игрока, но сделать ход за него можно только в его очередь.</p>
          <fieldset class="dealer-player-action-modal__grid" :disabled="!canAct">
            <button type="button" class="btn" @click="submit('check')">{{ actionLabels.check }}</button>
            <button type="button" class="btn" @click="submit('call')">{{ actionLabels.call }}</button>
            <button type="button" class="btn" @click="submit('bet')">{{ actionLabels.bet }}</button>
            <button type="button" class="btn" @click="submit('raise')">{{ actionLabels.raise }}</button>
            <button type="button" class="btn btn--danger" @click="submit('fold')">{{ actionLabels.fold }}</button>
            <button type="button" class="btn btn--success" @click="submit('all-in')">{{ actionLabels.allIn }}</button>
          </fieldset>

          <button type="button" class="btn btn--danger" @click="emit('kick')">Выгнать игрока</button>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped lang="scss">
.dealer-player-action-modal {
  position: fixed;
  inset: 0;
  background: rgba(8, 13, 11, 0.7);
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 1rem;

  &__card {
    width: min(520px, 100%);
    border-radius: var(--radius-lg);
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: #11261a;
    padding: 1rem;
    display: grid;
    gap: 0.7rem;
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
  }

  h3,
  p {
    margin: 0;
  }

  p {
    color: var(--text-muted);
  }

  label {
    display: grid;
    gap: 0.35rem;

    span {
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
  }
  &__profile { display: grid; grid-template-columns: repeat(3, 1fr); gap: .4rem; span { display: grid; gap: .15rem; padding: .55rem; border-radius: var(--radius-sm); color: var(--text-muted); background: #ffffff0a; text-align: center; } strong { color: var(--accent); } }
  &__icons { display: flex; flex-wrap: wrap; gap: .3rem; span { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: rgba(242,180,81,.12); } }
}

.dealer-action-fade-enter-active,
.dealer-action-fade-leave-active {
  transition: opacity 0.2s ease;
}

.dealer-action-fade-enter-from,
.dealer-action-fade-leave-to {
  opacity: 0;
}
</style>
