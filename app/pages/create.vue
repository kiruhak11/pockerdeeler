<script setup lang="ts">
import { usePlayerSessionStore } from "~/stores/playerSession"
import { useAccountStore } from '~/stores/account'
import { useAccountAuth } from '~/composables/useAccountAuth'
import { parseQuickBetSteps, formatQuickBetSteps } from '~/utils/quickBetSteps'
const sessionStore = usePlayerSessionStore()
const accountStore = useAccountStore()
const { loadMe } = useAccountAuth()

const form = reactive({
  accessMode: 'public',
  playerPolicy: 'mixed',
  password: '',
  name: 'Домашняя игра',
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 8,
  quickBetStepsText: formatQuickBetSteps([50, 100, 500]),
  allowLateJoin: false,
  requireDealerActionApproval: true,
  allowSpectators: true,
  buyIn: {
    enabled: true,
    minBuyIn: 5000,
    maxBuyIn: 7000,
    allowTopUp: false
  },
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
  },
  roster: {
    requireDealerApproval: true,
    lockRosterAfterGameStart: true,
    allowDealerAccountRebinding: true
  }
})

const isSubmitting = ref(false)

onMounted(async () => {
  accountStore.loadSession()
  if (accountStore.token) {
    await loadMe().catch(() => accountStore.clearSession())
  }
})

async function submit() {
  isSubmitting.value = true
  try {
    const response = await $fetch<{
      roomCode: string
      dealerUrl: string
      joinUrl: string
      dealerSecret: string
    }>('/api/rooms/create', {
      method: 'POST',
      body: {
        ...form,
        quickBetSteps: parseQuickBetSteps(form.quickBetStepsText),
        authToken: accountStore.token || undefined
      }
    })

    sessionStore.saveSession({
      roomCode: response.roomCode,
      playerId: null,
      participantId: null,
      role: 'dealer',
      token: null,
      dealerSecret: response.dealerSecret
    })

    await navigateTo(`/room/${response.roomCode}/dealer`)
  } catch (error) {
    alert(error instanceof Error ? error.message : 'Не удалось создать комнату')
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <main class="page-shell create-room-page">
    <header class="create-hero">
      <div><p class="create-hero__eyebrow">НОВЫЙ СТОЛ</p><h1 class="page-title">Соберите свою игру</h1><p class="page-subtitle">Четыре понятных блока, затем останется только отправить друзьям код.</p></div>
      <div class="create-hero__steps"><span class="active">1</span><i /><span>2</span><i /><span>3</span><i /><span>4</span></div>
      <p v-if="accountStore.user" class="create-hero__account">Создаёт <strong>{{ accountStore.user.username }}</strong></p>
    </header>

    <form class="panel create-room-page__form" @submit.prevent="submit">
      <section class="settings-group settings-group--basics">
        <div class="settings-group__heading"><span class="settings-group__number">01</span><div><p class="settings-group__eyebrow">Основа комнаты</p><h2>Название, доступ и ставки</h2><p>То, что увидят игроки перед входом.</p></div></div>
        <div class="settings-grid">
      <label>
        <span>Доступ к комнате</span>
        <select v-model="form.accessMode" class="input">
          <option value="public">Открытая: вход без пароля</option>
          <option value="private">Закрытая: вход по паролю</option>
        </select>
      </label>
      <label v-if="form.accessMode === 'private'">
        <span>Пароль комнаты (от 4 символов)</span>
        <input v-model="form.password" class="input" type="password" minlength="4" maxlength="128" autocomplete="new-password" required>
      </label>
      <label>
        <span>Кто может присоединиться</span>
        <select v-model="form.playerPolicy" class="input">
          <option value="mixed">Все: аккаунты и гости</option>
          <option value="accounts">Только с аккаунтами</option>
          <option value="guests" :disabled="form.predictions.enabled">Только гости</option>
        </select>
      </label>
      <label>
        <span>Название сессии</span>
        <input v-model="form.name" class="input" type="text" required>
      </label>

      <label>
        <span>Стартовый стек гостей (аккаунты используют свой баланс)</span>
        <input v-model.number="form.startingStack" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Малый блайнд</span>
        <input v-model.number="form.smallBlind" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Большой блайнд</span>
        <input v-model.number="form.bigBlind" class="input" type="number" min="1" required>
      </label>

      <label>
        <span>Максимум игроков</span>
        <input v-model.number="form.maxPlayers" class="input" type="number" min="2" max="10" required>
      </label>

      <label>
        <span>Быстрые кнопки ставок (через запятую)</span>
        <input v-model="form.quickBetStepsText" class="input" type="text" placeholder="50, 100, 500">
      </label>
        </div>
        <p class="settings-group__example">Закрытая комната потребует пароль даже при входе по приглашению.</p>
      </section>

      <section class="settings-group">
        <div class="settings-group__heading"><span class="settings-group__number">02</span><div>
          <p class="settings-group__eyebrow">Баланс аккаунта и стол</p>
          <h2>Выбранный бай-ин</h2>
          <p>Игрок с аккаунтом сам выбирает, сколько фишек взять за стол. Остаток безопасно остаётся в его кошельке.</p>
        </div></div>
        <label class="check">
          <input v-model="form.buyIn.enabled" type="checkbox">
          <span>Включить выбор бай-ина</span>
        </label>
        <div v-if="form.buyIn.enabled" class="settings-grid">
          <label>
            <span>Минимальный бай-ин</span>
            <input v-model.number="form.buyIn.minBuyIn" class="input" type="number" min="1" required>
          </label>
          <label>
            <span>Максимальный бай-ин</span>
            <input v-model.number="form.buyIn.maxBuyIn" class="input" type="number" :min="form.buyIn.minBuyIn" required>
          </label>
        </div>
        <label v-if="form.buyIn.enabled" class="check">
          <input v-model="form.buyIn.allowTopUp" type="checkbox">
          <span>Разрешить пополнение стека между раздачами</span>
        </label>
        <p v-if="form.buyIn.enabled" class="settings-group__example">
          Пример: с кошельком 20 000 игрок выберет {{ form.buyIn.minBuyIn }}–{{ form.buyIn.maxBuyIn }}, а остаток останется свободным.
        </p>
      </section>

      <section class="settings-group settings-group--prediction">
        <h2>Жетоны прогнозов</h2>
        <label class="check"><input v-model="form.predictions.enabled" type="checkbox"><span>Включить прогнозы на игроков</span></label>
        <p>Каждую раздачу — 3 жетона. Распределяйте их до первого действия, на себя поставить нельзя. Награда удерживается из максимум 10% чистого выигрыша выбранного победителя и делится пропорционально жетонам. Неиспользованные жетоны сгорают.</p>
      </section>

      <section class="settings-group">
        <div class="settings-group__heading"><span class="settings-group__number">04</span><div>
          <p class="settings-group__eyebrow">Защита состава</p>
          <h2>Участники вечера</h2>
          <p>После старта новый аккаунт не получает место автоматически: дилер решает, новый это человек или прежний участник.</p>
        </div></div>
        <label class="check">
          <input v-model="form.roster.lockRosterAfterGameStart" type="checkbox">
          <span>Зафиксировать состав после начала игры</span>
        </label>
        <label class="check">
          <input v-model="form.roster.requireDealerApproval" type="checkbox">
          <span>Подтверждать новых участников дилером</span>
        </label>
      </section>

      <section class="create-final">
        <div class="create-final__options"><label class="check"><input v-model="form.allowLateJoin" type="checkbox"><span>Поздний вход</span></label><label class="check"><input v-model="form.requireDealerActionApproval" type="checkbox"><span>Подтверждение действий</span></label><label class="check"><input v-model="form.allowSpectators" type="checkbox"><span>Зрители</span></label></div>
        <div class="create-final__summary"><span>Готово к запуску</span><strong>{{ form.name }} · {{ form.smallBlind }}/{{ form.bigBlind }}</strong></div>
        <button type="submit" class="btn create-final__submit" :disabled="isSubmitting">{{ isSubmitting ? 'Создаём стол…' : 'Создать комнату →' }}</button>
      </section>
    </form>
  </main>
</template>

<style scoped lang="scss">
.create-room-page {
  display: grid;
  gap: 1rem;
  padding-block: 1rem 2rem;

  &__form {
    display: grid;
    gap: 0.75rem;

    label {
      display: grid;
      gap: 0.35rem;

      span {
        color: var(--text-muted);
        font-size: var(--text-sm);
      }
    }
  }
}
.create-hero { position: relative; overflow: hidden; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1rem; padding: 1.35rem; border: 1px solid rgba(242,180,81,.2); border-radius: 28px; background: radial-gradient(circle at 86% 0, rgba(242,180,81,.18), transparent 38%), linear-gradient(135deg, #17432f, #0d241a); }
.create-hero__eyebrow { margin: 0 0 .45rem; color: var(--accent); font-size: .68rem; font-weight: 900; letter-spacing: .17em; }
.create-hero__steps { display: flex; align-items: center; span { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid rgba(255,255,255,.13); border-radius: 50%; color: var(--text-muted); font-size: .72rem; font-weight: 900; } span.active { color: #132018; border-color: var(--accent); background: var(--accent); } i { width: 18px; height: 1px; background: rgba(255,255,255,.13); } }
.create-hero__account { grid-column: 1 / -1; margin: 0; color: var(--text-muted); font-size: .8rem; }

.check {
  display: flex !important;
  gap: 0.5rem;
  align-items: center;
}

.settings-group {
  display: grid;
  gap: 0.8rem;
  padding: 1rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.18);

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 1.2rem;
  }

  p:not(.settings-group__eyebrow) {
    margin-top: 0.35rem;
    color: var(--text-muted);
    line-height: 1.45;
  }

  &--prediction {
    border-color: rgba(240, 188, 79, 0.28);
    background: linear-gradient(135deg, rgba(240, 188, 79, 0.08), rgba(0, 0, 0, 0.18));
  }

  &--basics { border-color: rgba(90,196,130,.22); background: linear-gradient(135deg, rgba(90,196,130,.06), rgba(0,0,0,.18)); }

  &__heading { display: flex; gap: .75rem; align-items: flex-start; }

  &__number { flex: none; display: grid; place-items: center; width: 2.1rem; height: 2.1rem; border-radius: 11px; color: var(--accent); background: rgba(242,180,81,.1); font-size: .7rem; font-weight: 900; }

  &__eyebrow {
    color: var(--accent-strong);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  details {
    display: grid;
    gap: 0.8rem;

    summary {
      cursor: pointer;
      color: var(--accent-strong);
      font-weight: 700;
    }
  }

  &__advanced {
    margin-top: 0.8rem;
  }
}

.create-final { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .8rem; padding: 1rem; border: 1px solid rgba(242,180,81,.24); border-radius: 20px; background: linear-gradient(120deg, rgba(242,180,81,.1), rgba(11,31,22,.9)); }
.create-final__options { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: .8rem 1.2rem; }
.create-final__summary { display: grid; gap: .15rem; span { color: var(--success); font-size: .68rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; } }
.create-final__submit { min-width: 210px; }

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
}

@media (max-width: 620px) {
  .create-hero { grid-template-columns: 1fr; padding: 1rem; border-radius: 22px; }
  .create-hero__steps { justify-content: space-between; }
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .create-final { grid-template-columns: 1fr; }
  .create-final__submit { min-width: 0; width: 100%; }
}
</style>
