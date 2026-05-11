<script setup lang="ts">
import { useGameStore } from "~/stores/game"
import type { GameVariant } from "~/types/game"

const gameStore = useGameStore()

const playerForm = reactive({
  name: '',
  stack: 1000,
  seat: null as number | null
})

const settingsForm = reactive({
  variant: 'texas-holdem' as GameVariant,
  smallBlind: 5,
  bigBlind: 10,
  quickRaiseSteps: [10, 25, 50, 100] as number[]
})

const editableRows = ref<Record<string, { name: string; stack: number; seat: number | null }>>({})

onMounted(() => {
  if (!gameStore.hydrated) {
    gameStore.loadFromLocalStorage()
  }

  gameStore.ensureGame()
  syncRows()
  syncSettingsFromGame()
})

watch(
  () => gameStore.game?.players,
  () => {
    syncRows()
  },
  { deep: true }
)

watch(
  () => [
    gameStore.game?.variant,
    gameStore.game?.smallBlind,
    gameStore.game?.bigBlind,
    ...(gameStore.game?.quickRaiseSteps ?? [])
  ],
  () => {
    syncSettingsFromGame()
  }
)

const game = computed(() => gameStore.game)
const players = computed(() => game.value?.players ?? [])
const canStart = computed(() => players.value.length >= 2)
const isSetupStage = computed(() => game.value?.handStage === 'setup')

function syncRows() {
  const next: Record<string, { name: string; stack: number; seat: number | null }> = {}
  for (const player of gameStore.game?.players ?? []) {
    next[player.id] = {
      name: player.name,
      stack: player.stack,
      seat: player.seat ?? null
    }
  }
  editableRows.value = next
}

function syncSettingsFromGame() {
  const currentGame = gameStore.game
  if (!currentGame) {
    return
  }

  settingsForm.variant = currentGame.variant
  settingsForm.smallBlind = currentGame.smallBlind
  settingsForm.bigBlind = currentGame.bigBlind

  const defaults = [10, 25, 50, 100]
  settingsForm.quickRaiseSteps = defaults.map((fallback, index) => {
    const value = currentGame.quickRaiseSteps[index]
    return typeof value === 'number' && value > 0 ? value : fallback
  })
}

function saveRoomSettings(): boolean {
  return Boolean(
    gameStore.setRoomSettings({
      variant: settingsForm.variant,
      smallBlind: settingsForm.smallBlind,
      bigBlind: settingsForm.bigBlind,
      quickRaiseSteps: settingsForm.quickRaiseSteps
    })
  )
}

function addPlayer() {
  const seat = typeof playerForm.seat === 'number' && Number.isFinite(playerForm.seat)
    ? playerForm.seat
    : undefined

  gameStore.addPlayer({
    name: playerForm.name,
    stack: playerForm.stack,
    seat
  })

  playerForm.name = ''
  playerForm.stack = 1000
  playerForm.seat = null
}

function savePlayer(playerId: string) {
  const row = editableRows.value[playerId]
  if (!row) {
    return
  }

  const seat = typeof row.seat === 'number' && Number.isFinite(row.seat)
    ? row.seat
    : null

  gameStore.updatePlayer(playerId, {
    name: row.name,
    stack: row.stack,
    seat
  })
}

function removePlayer(playerId: string) {
  gameStore.removePlayer(playerId)
}

function getRow(player: { id: string; name: string; stack: number; seat?: number }) {
  if (!editableRows.value[player.id]) {
    editableRows.value[player.id] = {
      name: player.name,
      stack: player.stack,
      seat: player.seat ?? null
    }
  }

  return editableRows.value[player.id]!
}

async function startGame() {
  const settingsSaved = saveRoomSettings()
  if (!settingsSaved) {
    return
  }

  const started = gameStore.startGame()
  if (started) {
    await navigateTo('/game')
  }
}
</script>

<template>
  <main class="page-shell setup-page">
    <header class="setup-page__head">
      <h1 class="page-title">Настройка игры</h1>
      <p class="page-subtitle">Настройте блайнды и быстрые повышения, затем добавьте игроков.</p>
    </header>

    <section v-if="!isSetupStage" class="panel setup-page__warning">
      <p>Игра уже запущена. Чтобы изменить состав или правила, начните новую игру.</p>
      <div class="setup-page__actions">
        <NuxtLink class="btn btn--ghost" to="/game">К игре</NuxtLink>
        <NuxtLink class="btn" to="/">На главную</NuxtLink>
      </div>
    </section>

    <template v-else>
      <section class="panel setup-page__settings">
        <h2>Параметры комнаты</h2>
        <div class="setup-page__settings-grid">
          <label class="setup-page__field">
            <span>Вариант игры</span>
            <select v-model="settingsForm.variant" class="select">
              <option value="texas-holdem">Техасский холдем</option>
              <option value="omaha">Омаха</option>
            </select>
          </label>

          <label class="setup-page__field">
            <span>Малый блайнд</span>
            <input v-model.number="settingsForm.smallBlind" class="input" type="number" min="1">
          </label>

          <label class="setup-page__field">
            <span>Большой блайнд</span>
            <input v-model.number="settingsForm.bigBlind" class="input" type="number" min="1">
          </label>
        </div>

        <div class="setup-page__quick-grid">
          <label v-for="(_, index) in settingsForm.quickRaiseSteps" :key="index" class="setup-page__field">
            <span>Быстрое повышение {{ index + 1 }}</span>
            <input v-model.number="settingsForm.quickRaiseSteps[index]" class="input" type="number" min="1">
          </label>
        </div>

        <button type="button" class="btn btn--ghost" @click="saveRoomSettings">Сохранить параметры</button>
      </section>

      <section class="panel setup-page__add">
        <h2>Добавить игрока</h2>
        <div class="setup-page__grid">
          <input v-model="playerForm.name" class="input" placeholder="Имя игрока" type="text">
          <input v-model.number="playerForm.stack" class="input" placeholder="Стартовый стек" type="number" min="1">
          <input v-model.number="playerForm.seat" class="input" placeholder="Место (авто, если пусто)" type="number" min="1">
          <button type="button" class="btn" @click="addPlayer">Добавить</button>
        </div>
      </section>

      <section class="panel setup-page__list">
        <h2>Игроки</h2>

        <p v-if="players.length === 0" class="setup-page__empty">Пока нет игроков.</p>

        <div v-for="player in players" :key="player.id" class="setup-page__row">
          <input v-model="getRow(player).name" class="input" type="text" placeholder="Имя">
          <input v-model.number="getRow(player).stack" class="input" type="number" min="1" placeholder="Стек">
          <input
            v-model.number="getRow(player).seat"
            class="input"
            type="number"
            min="1"
            placeholder="Место"
          >
          <button type="button" class="btn btn--ghost" @click="savePlayer(player.id)">Сохранить</button>
          <button type="button" class="btn btn--danger" @click="removePlayer(player.id)">Удалить</button>
        </div>
      </section>

      <section class="setup-page__footer">
        <button type="button" class="btn" :disabled="!canStart" @click="startGame">Начать игру</button>
        <NuxtLink class="btn btn--ghost" to="/">На главную</NuxtLink>
      </section>
    </template>
  </main>
</template>

<style scoped lang="scss">
.setup-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__head {
    display: grid;
    gap: 0.3rem;
  }

  &__field {
    display: grid;
    gap: 0.35rem;

    span {
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
  }

  &__settings,
  &__list,
  &__add {
    display: grid;
    gap: 0.75rem;

    h2 {
      margin: 0;
      font-size: 1.2rem;
    }
  }

  &__settings-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  &__quick-grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  &__grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr auto;
    gap: 0.6rem;
    margin-top: 0.3rem;
  }

  &__empty {
    margin: 0;
    color: var(--text-muted);
  }

  &__row {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr auto auto;
    gap: 0.55rem;
  }

  &__footer,
  &__actions {
    display: flex;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
}

@media (max-width: 920px) {
  .setup-page {
    &__settings-grid {
      grid-template-columns: 1fr;
    }

    &__quick-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    &__grid,
    &__row {
      grid-template-columns: 1fr;
    }
  }
}
</style>
