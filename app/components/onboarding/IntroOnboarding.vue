<script setup lang="ts">
import PwaDialog from '../pwa/PwaDialog.vue'
import { ONBOARDING_VERSION } from '~/composables/usePwaPreferences'
const { state, persist } = usePwa()
const step = ref(0)
const steps = [
  { title: 'Настоящие карты, фишки на телефоне', text: 'Соберитесь за одним столом. Раздавайте настоящие карты: сайт заменяет фишки, считает ставки и общий банк. Виртуальной раздачи здесь нет.' },
  { title: 'Дождитесь своего хода', text: 'В онлайн-комнате каждый действует со своего телефона. Проверяйте свой стек, банк и сумму доплаты. Чек означает ход без ставки, уравнять (колл) значит доплатить до ставки стола, пас означает выйти из этой раздачи.' },
  { title: 'Повысить до, а не добавить', text: 'Пример: вы уже внесли 200, а повышаете до 600. Из стека уйдёт ещё 400. Это пример, не текущая ставка. Ва-банк означает поставить весь оставшийся стек; при разных стеках возможен побочный банк.' },
  { title: 'Победителя указывает дилер', text: 'В конце раздачи покажите настоящие карты. Дилер указывает победителей и распределяет банк. Зрители не делают обычные ставки; прогнозы выбывших, если включены, находятся отдельно. Онлайн-комнате нужен интернет, локальный стол работает только на одном устройстве.' }
]
const current = computed(() => steps[step.value]!)
function finish(result: 'completed' | 'skipped') {
  state.value.preferences.onboardingVersion = ONBOARDING_VERSION
  state.value.preferences.onboardingResult = result
  persist()
  state.value.dialog = null
}
</script>

<template>
  <PwaDialog title="Как играть" @close="finish('skipped')">
    <p class="step-label">Знакомство с Poker Dealer Desk · {{ step + 1 }} из {{ steps.length }}</p>
    <div class="step-progress" aria-hidden="true"><span v-for="(_, index) in steps" :key="index" :class="{ filled: index <= step }" /></div>
    <div aria-live="polite" aria-atomic="true"><h3>{{ current.title }}</h3><p>{{ current.text }}</p></div>
    <details v-if="step === 2"><summary>Коротко о терминах</summary><dl><dt>Стек</dt><dd>Ваши оставшиеся фишки.</dd><dt>Банк</dt><dd>Все фишки, поставленные в раздаче.</dd><dt>Блайнды</dt><dd>Обязательные ставки перед началом торговли.</dd><dt>Рейз</dt><dd>Повышение ставки стола.</dd><dt>Побочный банк</dt><dd>Часть ставок, за которую борются только внесшие её игроки.</dd></dl></details>
    <div class="pwa-actions">
      <button v-if="step" type="button" class="btn btn--ghost" @click="step--">Назад</button>
      <button v-if="step < steps.length - 1" type="button" class="btn" @click="step++">Далее</button>
      <button v-else type="button" class="btn" @click="finish('completed')">Понятно, к игре</button>
      <button type="button" class="btn btn--ghost" @click="finish('skipped')">Пропустить</button>
    </div>
    <p class="step-label">Обучение всегда доступно по кнопке «Как играть».</p>
  </PwaDialog>
</template>

<style scoped>
.step-label { color: var(--text-muted); font-size: .85rem; }
.step-progress { display: flex; gap: 6px; }
.step-progress span { height: 4px; flex: 1; background: #526157; border-radius: 4px; }
.step-progress .filled { background: var(--accent); }
h3 { font-size: 1.4rem; line-height: 1.35; }
summary { cursor: pointer; padding: 12px 0; }
dt { font-weight: bold; color: var(--accent); }
dd { margin: 0 0 10px; }
</style>
