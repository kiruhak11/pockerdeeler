<script setup lang="ts">
import type { PlayerActionType } from '~/types/game'

const props = defineProps<{
  visible: boolean
  playerName: string
  playerStack: number
}>()

const emit = defineEmits<{
  close: []
  forceAction: [payload: { type: PlayerActionType; amount: number }]
  kick: []
}>()

const amount = ref(0)

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      amount.value = 0
    }
  }
)

function submit(type: PlayerActionType) {
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

          <p>Стек игрока: {{ playerStack }}</p>

          <label>
            <span>Сумма</span>
            <input v-model.number="amount" class="input" type="number" min="0">
          </label>

          <div class="dealer-player-action-modal__grid">
            <button type="button" class="btn" @click="submit('check')">Чек</button>
            <button type="button" class="btn" @click="submit('call')">Колл</button>
            <button type="button" class="btn" @click="submit('bet')">Ставка</button>
            <button type="button" class="btn" @click="submit('raise')">Рейз</button>
            <button type="button" class="btn btn--danger" @click="submit('fold')">Пас</button>
            <button type="button" class="btn btn--success" @click="submit('all-in')">Ва-банк</button>
          </div>

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
