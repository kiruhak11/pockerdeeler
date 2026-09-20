<script setup lang="ts">
type ConsentState = { termsAccepted: boolean; virtualCurrencyAcknowledged: boolean; virtualChipsRulesAccepted?: boolean; ageConfirmed: boolean; personalDataConsent: boolean }
const props = withDefaults(defineProps<{ mode: 'PREMIUM' | 'VIRTUAL_CHIPS'; requirePersonalDataConsent?: boolean; modelValue: ConsentState }>(), { requirePersonalDataConsent: false })
const emit = defineEmits<{ 'update:modelValue': [value: ConsentState] }>()
function set(key: keyof ConsentState, value: boolean) { emit('update:modelValue', { ...props.modelValue, [key]: value }) }
</script>

<template>
  <fieldset class="legal-consents">
    <legend>Подтверждение условий</legend>
    <label v-if="mode === 'PREMIUM'"><input type="checkbox" :checked="modelValue.termsAccepted" @change="set('termsAccepted', ($event.target as HTMLInputElement).checked)"><span>Я принимаю условия <NuxtLink to="/legal/offer" target="_blank">Публичной оферты</NuxtLink>.</span></label>
    <label v-else><input type="checkbox" :checked="modelValue.termsAccepted" @change="set('termsAccepted', ($event.target as HTMLInputElement).checked)"><span>Я принимаю условия <NuxtLink to="/legal/offer" target="_blank">Публичной оферты</NuxtLink> и <NuxtLink to="/legal/game-rules" target="_blank">Правил сервиса</NuxtLink>.</span></label>
    <label v-if="mode === 'VIRTUAL_CHIPS'"><input type="checkbox" :checked="modelValue.virtualChipsRulesAccepted === true" @change="set('virtualChipsRulesAccepted', ($event.target as HTMLInputElement).checked)"><span>Я принимаю <NuxtLink to="/legal/virtual-chips" target="_blank">Правила виртуальных фишек</NuxtLink>.</span></label>
    <label v-if="mode === 'VIRTUAL_CHIPS'"><input type="checkbox" :checked="modelValue.virtualCurrencyAcknowledged" @change="set('virtualCurrencyAcknowledged', ($event.target as HTMLInputElement).checked)"><span>Я понимаю, что игровые фишки являются внутренними виртуальными единицами сервиса, не являются денежными средствами и не подлежат выводу или обмену на реальные деньги или имущество.</span></label>
    <label v-if="mode === 'VIRTUAL_CHIPS'"><input type="checkbox" :checked="modelValue.ageConfirmed" @change="set('ageConfirmed', ($event.target as HTMLInputElement).checked)"><span>Мне исполнилось 18 лет.</span></label>
    <label v-if="requirePersonalDataConsent"><input type="checkbox" :checked="modelValue.personalDataConsent" @change="set('personalDataConsent', ($event.target as HTMLInputElement).checked)"><span>Я даю отдельное <NuxtLink to="/legal/personal-data-consent" target="_blank">согласие на обработку персональных данных</NuxtLink>.</span></label>
  </fieldset>
</template>

<style scoped>
.legal-consents{display:grid;gap:.8rem;margin:0;padding:1rem;border:1px solid rgba(255,255,255,.12);border-radius:14px}.legal-consents legend{padding:0 .35rem;color:var(--text-muted);font-size:.78rem}.legal-consents label{display:grid;grid-template-columns:20px 1fr;gap:.65rem;align-items:start;color:var(--text-muted);font-size:.82rem;line-height:1.5;cursor:pointer}.legal-consents input{width:18px;height:18px;margin:.1rem 0 0;accent-color:var(--accent)}.legal-consents a{color:var(--accent)}
</style>
