<script setup lang="ts">
import type { ActionInput } from "~/types/game"
import { useGameStore } from "~/stores/game"

const gameStore = useGameStore()

onMounted(async () => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }

  if (!gameStore.game) {
    await navigateTo('/')
  }
})

const game = computed(() => gameStore.game)
const players = computed(() => game.value?.players ?? [])
const canPlay = computed(() => game.value?.handStage === 'playing' && game.value.handActive)
const isShowdown = computed(() => game.value?.handStage === 'showdown')
const isCompleted = computed(() => game.value?.handStage === 'completed')
const latestHistory = computed(() => game.value?.history[0])
const isSetup = computed(() => game.value?.handStage === "setup")

function performAction(payload: ActionInput) {
  gameStore.performAction(payload)
}

function finishHand() {
  gameStore.finishHand()
}

function updateWinners(ids: string[]) {
  gameStore.setPendingWinners(ids)
}

function distributePot() {
  gameStore.distributePot()
}

function undo() {
  gameStore.undoLastAction()
}

function resetHand() {
  if (!window.confirm('Сбросить текущую раздачу?')) {
    return
  }

  gameStore.resetCurrentHand()
}

async function newGame() {
  if (!window.confirm('Начать новую игру и сбросить текущие данные?')) {
    return
  }

  gameStore.resetGame()
  await navigateTo('/setup')
}

function nextHand() {
  gameStore.startNewHand()
}

function startExistingGame() {
  gameStore.startGame()
}
</script>

<template>
  <main v-if="game" class="page-shell game-page">
    <header class="game-page__head">
      <div>
        <h1 class="page-title">Игровой стол</h1>
        <p class="page-subtitle">Фиксируйте действия игроков и ведите банк без ручных расчетов.</p>
      </div>

      <div class="game-page__nav">
        <NuxtLink class="btn btn--ghost" to="/history">История</NuxtLink>
        <button type="button" class="btn btn--danger" @click="newGame">Новая игра</button>
      </div>
    </header>

    <PotSummary
      :pot="game.pot"
      :current-bet="game.currentBet"
      :hand-number="game.handNumber"
      :stage="game.handStage"
      :variant="game.variant"
      :small-blind="game.smallBlind"
      :big-blind="game.bigBlind"
      :players="players"
    />

    <section class="game-page__controls panel">
      <button type="button" class="btn" :disabled="!canPlay" @click="finishHand">Завершить раздачу</button>
      <button type="button" class="btn btn--ghost" :disabled="!canPlay" @click="undo">Отменить последнее действие</button>
      <button type="button" class="btn btn--ghost" :disabled="!canPlay" @click="resetHand">Сбросить раздачу</button>
    </section>

    <section v-if="isSetup" class="panel game-page__completed">
      <h2>Игра еще не запущена</h2>
      <p>Завершите настройку или сразу начните первую раздачу.</p>
      <div class="game-page__nav">
        <NuxtLink class="btn btn--ghost" to="/setup">К настройке</NuxtLink>
        <button type="button" class="btn" @click="startExistingGame">Начать игру</button>
      </div>
    </section>

    <WinnerSelector
      v-if="isShowdown"
      :players="players"
      :pot="game.pot"
      :selected="game.pendingWinners"
      @update:selected="updateWinners"
      @distribute="distributePot"
    />

    <section v-if="isCompleted" class="panel game-page__completed">
      <h2>Раздача завершена</h2>
      <p v-if="latestHistory?.winners.length">Итоговые выплаты уже зафиксированы в истории.</p>
      <button type="button" class="btn btn--success" @click="nextHand">Следующая раздача</button>
    </section>

    <section class="game-page__players">
      <PlayerCard
        v-for="player in players"
        :key="player.id"
        :player="player"
        :table-current-bet="game.currentBet"
        :quick-raise-steps="game.quickRaiseSteps"
        :actions-disabled="!canPlay"
        @action="performAction"
      />
    </section>
  </main>
</template>

<style scoped lang="scss">
.game-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  &__nav {
    display: flex;
    gap: 0.7rem;
    flex-wrap: wrap;
  }

  &__controls {
    display: flex;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  &__players {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  &__completed {
    display: grid;
    gap: 0.75rem;

    h2,
    p {
      margin: 0;
    }
  }
}

@media (max-width: 1000px) {
  .game-page {
    &__players {
      grid-template-columns: 1fr;
    }

    &__head {
      flex-direction: column;
    }
  }
}
</style>
