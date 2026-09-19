<script setup lang="ts">
import type { BuyInOptionsView } from '~/types/room'
const props = defineProps<{ options: BuyInOptionsView | null; busy?: boolean; handActive?: boolean }>()
const emit = defineEmits<{ topUp: [amount: number]; returnStack: [amount: number] }>()
const topUpAmount = ref(100)
const returnAmount = ref(100)
const notice = ref('')
const valid = (amount: number, maximum: number) => !props.busy && !props.handActive && Number.isSafeInteger(amount) && amount > 0 && amount <= maximum
function submit(kind: 'topUp' | 'returnStack') {
  const amount = kind === 'topUp' ? topUpAmount.value : returnAmount.value
  const maximum = kind === 'topUp' ? props.options?.maximumTopUp : props.options?.currentStack
  if (!valid(amount,maximum || 0)) return
  if (!confirm(`${kind === 'topUp' ? 'Добавить в стек' : 'Вернуть на баланс'} ${amount.toLocaleString('ru-RU')} фишек?`)) return
  notice.value = ''
  if (kind === 'topUp') emit('topUp', amount)
  else emit('returnStack', amount)
}
watch(() => props.options?.currentStack, (stack, previous) => {
  if (stack != null && previous != null && stack < previous) notice.value = 'Свободные фишки возвращены на баланс.'
})
</script>
<template>
  <section v-if="options" class="panel transfer">
    <header><small>КОНТРОЛЬ ФИШЕК</small><h3>Стек ↔ баланс</h3><p>Баланс: {{ options.walletBalance.toLocaleString('ru-RU') }} · Стек: {{ options.currentStack.toLocaleString('ru-RU') }}</p></header>
    <p v-if="handActive">Переводы доступны после завершения текущей раздачи.</p>
    <div v-if="options.enabled && options.allowTopUp" class="controls">
      <label>Добавить в стек · до {{ options.maximumTopUp }}<input v-model.number="topUpAmount" class="input" type="number" min="1" :max="options.maximumTopUp" :disabled="busy || handActive"></label>
      <button class="btn" :disabled="!valid(topUpAmount,options.maximumTopUp)" @click="submit('topUp')">Добавить в стек</button>
    </div>
    <div class="presets"><button v-for="fraction in [.25,.5,1]" :key="fraction" class="btn btn--ghost" :disabled="busy || handActive || !options.currentStack" @click="returnAmount = Math.floor(options.currentStack*fraction)">{{ fraction === 1 ? 'Всё' : fraction*100 + '%' }}</button></div>
    <div class="controls">
      <label>Вернуть на баланс · до {{ options.currentStack }}<input v-model.number="returnAmount" class="input" type="number" min="1" :max="options.currentStack" :disabled="busy || handActive"></label>
      <button class="btn btn--ghost" :disabled="!valid(returnAmount,options.currentStack)" @click="submit('returnStack')">Вернуть на баланс</button>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>.transfer{display:grid;gap:.8rem;padding:1rem}.transfer h3,.transfer p{margin:.25rem 0}.transfer small{color:var(--accent);letter-spacing:.1em}.controls{display:grid;grid-template-columns:1fr auto;gap:.7rem;align-items:end}.controls label{display:grid;gap:.4rem;color:var(--text-muted);font-size:.85rem}.presets{display:flex;gap:.5rem}@media(max-width:540px){.controls{grid-template-columns:1fr}}</style>
