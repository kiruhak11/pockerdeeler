<script setup lang="ts">
import type { BuyInSettings, PredictionSettings, RoomSettings, RosterSettings } from '~/types/room'
import { formatQuickBetSteps, parseQuickBetSteps } from '~/utils/quickBetSteps'

type EditableBuyIn = Pick<BuyInSettings, 'enabled' | 'minBuyIn' | 'maxBuyIn' | 'allowTopUp'>
type EditablePrediction = Omit<PredictionSettings, 'question' | 'marketOpenStreet' | 'hidePredictionsFromPlayers'>

interface SettingsPayload {
  startingStack: number
  smallBlind: number
  bigBlind: number
  maxPlayers: number
  quickBetSteps: number[]
  allowLateJoin: boolean
  requireDealerActionApproval: boolean
  allowSpectators: boolean
  buyIn: EditableBuyIn
  predictions: EditablePrediction
  roster: RosterSettings
}

const props = defineProps<{
  settings: RoomSettings | null
  playersCount: number
  disabled?: boolean
}>()

const emit = defineEmits<{ save: [payload: SettingsPayload] }>()

const form = reactive({
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 8,
  quickBetStepsText: formatQuickBetSteps([50, 100, 500]),
  allowLateJoin: false,
  requireDealerActionApproval: true,
  allowSpectators: true,
  buyIn: { enabled: true, minBuyIn: 5000, maxBuyIn: 7000, allowTopUp: false } as EditableBuyIn,
  predictions: {
    enabled: true,
    grantMode: 'original_buy_in',
    fixedGrant: 5000,
    minStake: 100,
    maxStake: 1000,
    maxStakePercentOfGrant: 20,
    gracePeriodSeconds: 0,
    virtualLiquidityPerMarket: 1000,
    treasuryInitialBalance: 100000,
    behaviorImpact: 0.2,
    includeDecisionTime: false,
    comebackMinBuyIn: 5000,
    comebackMaxBuyIn: 7000,
    maxReentriesPerMember: 1,
    requireDealerApprovalForReentry: true
  } as EditablePrediction,
  roster: {
    requireDealerApproval: true,
    lockRosterAfterGameStart: true,
    allowDealerAccountRebinding: true
  } as RosterSettings
})

const localError = ref('')

watch(
  () => props.settings,
  (settings) => {
    if (!settings) return
    form.startingStack = settings.startingStack
    form.smallBlind = settings.smallBlind ?? 5
    form.bigBlind = settings.bigBlind ?? Math.max((settings.smallBlind ?? 5) * 2, 10)
    form.maxPlayers = settings.maxPlayers
    form.quickBetStepsText = formatQuickBetSteps(settings.quickBetSteps)
    form.allowLateJoin = settings.allowLateJoin
    form.requireDealerActionApproval = settings.requireDealerActionApproval
    form.allowSpectators = settings.allowSpectators
    Object.assign(form.buyIn, settings.buyIn)
    Object.assign(form.predictions, settings.predictions)
    Object.assign(form.roster, settings.roster)
  },
  { immediate: true }
)

function submit() {
  localError.value = ''
  if (form.smallBlind <= 0 || form.bigBlind <= form.smallBlind) {
    localError.value = 'Большой блайнд должен быть больше положительного малого блайнда'
    return
  }
  if (form.maxPlayers < props.playersCount) {
    localError.value = `Максимум игроков не может быть меньше ${props.playersCount}`
    return
  }
  if (form.buyIn.maxBuyIn < form.buyIn.minBuyIn) {
    localError.value = 'Максимальный бай-ин не может быть меньше минимального'
    return
  }
  if (form.predictions.maxStake < form.predictions.minStake) {
    localError.value = 'Максимальный прогноз не может быть меньше минимального'
    return
  }
  if (form.predictions.comebackMaxBuyIn < form.predictions.comebackMinBuyIn) {
    localError.value = 'Проверьте диапазон возврата за стол'
    return
  }
  if (form.predictions.treasuryInitialBalance < form.predictions.virtualLiquidityPerMarket) {
    localError.value = 'Резерв должен покрывать ликвидность хотя бы одной раздачи'
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
    allowSpectators: form.allowSpectators,
    buyIn: { ...form.buyIn, minBuyIn: Math.trunc(form.buyIn.minBuyIn), maxBuyIn: Math.trunc(form.buyIn.maxBuyIn) },
    predictions: {
      ...form.predictions,
      fixedGrant: form.predictions.grantMode === 'fixed' ? Math.trunc(form.predictions.fixedGrant || 0) : undefined,
      minStake: Math.trunc(form.predictions.minStake),
      maxStake: Math.trunc(form.predictions.maxStake),
      maxStakePercentOfGrant: Math.trunc(form.predictions.maxStakePercentOfGrant),
      gracePeriodSeconds: Math.trunc(form.predictions.gracePeriodSeconds),
      virtualLiquidityPerMarket: Math.trunc(form.predictions.virtualLiquidityPerMarket),
      treasuryInitialBalance: Math.trunc(form.predictions.treasuryInitialBalance),
      comebackMinBuyIn: Math.trunc(form.predictions.comebackMinBuyIn),
      comebackMaxBuyIn: Math.trunc(form.predictions.comebackMaxBuyIn),
      maxReentriesPerMember: Math.trunc(form.predictions.maxReentriesPerMember)
    },
    roster: { ...form.roster }
  })
}
</script>

<template>
  <section class="panel dealer-room-settings">
    <header>
      <div>
        <p class="dealer-room-settings__eyebrow">Управление без пересоздания комнаты</p>
        <h3>Настройки лобби</h3>
      </div>
      <span>Правила прогнозов нельзя менять, пока текущий рынок открыт или зафиксирован.</span>
    </header>

    <div class="dealer-room-settings__grid">
      <label><span>Стек гостя</span><input v-model.number="form.startingStack" class="input" type="number" min="1"></label>
      <label><span>Малый блайнд</span><input v-model.number="form.smallBlind" class="input" type="number" min="1"></label>
      <label><span>Большой блайнд</span><input v-model.number="form.bigBlind" class="input" type="number" min="1"></label>
      <label><span>Максимум игроков</span><input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="10"></label>
    </div>

    <label><span>Кнопки быстрых ставок (+...)</span><input v-model="form.quickBetStepsText" class="input" type="text" placeholder="50, 100, 500"></label>

    <details>
      <summary>Бай-ин и пополнение стека</summary>
      <div class="dealer-room-settings__details">
        <label class="check"><input v-model="form.buyIn.enabled" type="checkbox"><span>Игрок сам выбирает бай-ин</span></label>
        <div class="dealer-room-settings__grid">
          <label><span>Минимальный бай-ин</span><input v-model.number="form.buyIn.minBuyIn" class="input" type="number" min="1"></label>
          <label><span>Максимальный бай-ин</span><input v-model.number="form.buyIn.maxBuyIn" class="input" type="number" min="1"></label>
        </div>
        <label class="check"><input v-model="form.buyIn.allowTopUp" type="checkbox"><span>Разрешить пополнение только между раздачами</span></label>
      </div>
    </details>

    <details class="dealer-room-settings__prediction">
      <summary>Жетоны прогнозов</summary>
      <div class="dealer-room-settings__details">
        <label class="check"><input v-model="form.predictions.enabled" type="checkbox"><span>Включить прогнозы на игроков</span></label>
        <p>По 3 жетона на раздачу до первого действия. До 10% чистого выигрыша победителя распределяется между правильными жетонами. Дополнительные фишки не создаются.</p>
      </div>
    </details>

    <details>
      <summary>Состав игрового вечера</summary>
      <div class="dealer-room-settings__details">
        <label class="check"><input v-model="form.roster.lockRosterAfterGameStart" type="checkbox"><span>Зафиксировать состав после старта</span></label>
        <label class="check"><input v-model="form.roster.requireDealerApproval" type="checkbox"><span>Подтверждать новых участников</span></label>
        <label class="check"><input v-model="form.roster.allowDealerAccountRebinding" type="checkbox"><span>Разрешить перепривязку аккаунта к участнику</span></label>
      </div>
    </details>

    <div class="dealer-room-settings__checks">
      <label class="check"><input v-model="form.allowLateJoin" type="checkbox"><span>Разрешить поздний вход</span></label>
      <label class="check"><input v-model="form.requireDealerActionApproval" type="checkbox"><span>Подтверждение действий дилером</span></label>
      <label class="check"><input v-model="form.allowSpectators" type="checkbox"><span>Разрешить зрителей</span></label>
    </div>

    <p v-if="localError" class="dealer-room-settings__error">{{ localError }}</p>
    <button type="button" class="btn" :disabled="disabled" @click="submit">Сохранить настройки</button>
  </section>
</template>

<style scoped lang="scss">
.dealer-room-settings {
  display: grid;
  gap: 0.8rem;

  header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;

    > span {
      max-width: 36rem;
      color: var(--text-muted);
      font-size: var(--text-sm);
      text-align: right;
    }
  }

  h3,
  p {
    margin: 0;
  }

  &__eyebrow {
    color: var(--accent-strong);
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  label,
  &__details {
    display: grid;
    gap: 0.35rem;
  }

  label span {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  &__grid {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  &__checks,
  &__details {
    gap: 0.55rem;
  }

  details {
    padding: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.13);
  }

  details[open] summary {
    margin-bottom: 0.8rem;
  }

  summary {
    cursor: pointer;
    font-weight: 750;
  }

  &__prediction {
    border-color: rgba(240, 188, 79, 0.27) !important;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  &__error {
    color: var(--danger);
  }
}

@media (max-width: 640px) {
  .dealer-room-settings header {
    display: grid;

    > span {
      text-align: left;
    }
  }
}
</style>
