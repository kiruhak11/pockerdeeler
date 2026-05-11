<script setup lang="ts">
import type { RoomSettings } from '~/types/room'
import { formatQuickBetSteps, parseQuickBetSteps } from '~/utils/quickBetSteps'

const props = defineProps<{
  settings: RoomSettings | null
  playersCount: number
  disabled?: boolean
}>()

const emit = defineEmits<{
  save: [payload: {
    startingStack: number
    smallBlind: number
    bigBlind: number
    maxPlayers: number
    quickBetSteps: number[]
    allowLateJoin: boolean
    requireDealerActionApproval: boolean
    allowSpectators: boolean
  }]
}>()

const form = reactive({
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 8,
  quickBetStepsText: formatQuickBetSteps([50, 100, 500]),
  allowLateJoin: false,
  requireDealerActionApproval: true,
  allowSpectators: true
})

const localError = ref('')

watch(
  () => props.settings,
  (settings) => {
    if (!settings) {
      return
    }

    form.startingStack = settings.startingStack
    form.smallBlind = settings.smallBlind ?? 5
    form.bigBlind = settings.bigBlind ?? Math.max((settings.smallBlind ?? 5) * 2, 10)
    form.maxPlayers = settings.maxPlayers
    form.quickBetStepsText = formatQuickBetSteps(settings.quickBetSteps)
    form.allowLateJoin = settings.allowLateJoin
    form.requireDealerActionApproval = settings.requireDealerActionApproval
    form.allowSpectators = settings.allowSpectators
  },
  { immediate: true }
)

function submit() {
  localError.value = ''

  if (form.smallBlind <= 0) {
    localError.value = 'Малый блайнд должен быть больше 0'
    return
  }

  if (form.bigBlind <= form.smallBlind) {
    localError.value = 'Большой блайнд должен быть больше малого'
    return
  }

  if (form.maxPlayers < props.playersCount) {
    localError.value = `Максимум игроков не может быть меньше ${props.playersCount}`
    return
  }

  emit('save', {
    startingStack: Math.trunc(form.startingStack),
    smallBlind: Math.trunc(form.smallBlind),
    bigBlind: Math.trunc(form.bigBlind),
    maxPlayers: Math.trunc(form.maxPlayers),
    quickBetSteps: parseQuickBetSteps(form.quickBetStepsText),
    allowLateJoin: form.allowLateJoin,
    requireDealerActionApproval: form.requireDealerActionApproval,
    allowSpectators: form.allowSpectators
  })
}
</script>

<template>
  <section class="panel dealer-room-settings">
    <h3>Настройки лобби</h3>

    <div class="dealer-room-settings__grid">
      <label>
        <span>Стартовый стек</span>
        <input v-model.number="form.startingStack" class="input" type="number" min="1">
      </label>

      <label>
        <span>Малый блайнд</span>
        <input v-model.number="form.smallBlind" class="input" type="number" min="1">
      </label>

      <label>
        <span>Большой блайнд</span>
        <input v-model.number="form.bigBlind" class="input" type="number" min="1">
      </label>

      <label>
        <span>Максимум игроков</span>
        <input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="10">
      </label>
    </div>

    <label>
      <span>Кнопки быстрых ставок (+...)</span>
      <input v-model="form.quickBetStepsText" class="input" type="text" placeholder="50, 100, 500">
    </label>

    <div class="dealer-room-settings__checks">
      <label class="check">
        <input v-model="form.allowLateJoin" type="checkbox">
        <span>Разрешить поздний вход</span>
      </label>

      <label class="check">
        <input v-model="form.requireDealerActionApproval" type="checkbox">
        <span>Подтверждение действий дилером</span>
      </label>

      <label class="check">
        <input v-model="form.allowSpectators" type="checkbox">
        <span>Разрешить зрителей</span>
      </label>
    </div>

    <p v-if="localError" class="dealer-room-settings__error">{{ localError }}</p>

    <button type="button" class="btn" :disabled="disabled" @click="submit">Сохранить настройки</button>
  </section>
</template>

<style scoped lang="scss">
.dealer-room-settings {
  display: grid;
  gap: 0.7rem;

  h3 {
    margin: 0;
  }

  label {
    display: grid;
    gap: 0.35rem;

    span {
      color: var(--text-muted);
      font-size: var(--text-sm);
    }
  }

  &__grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  &__checks {
    display: grid;
    gap: 0.5rem;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  &__error {
    margin: 0;
    color: var(--danger);
  }
}
</style>
