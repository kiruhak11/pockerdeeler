<script setup lang="ts">
useHead({ title: 'Статус платежа · Poker Dealer Desk' })
</script>
<template><main class="page-shell payment-return"><section class="panel"><p class="eyebrow">ПЛАТЕЖ</p><h1>Платёж отправлен на обработку</h1><p>Мы подтвердим оплату только по серверному уведомлению ЮKassa. Возврат на эту страницу сам по себе не активирует Premium и не начисляет фишки.</p><NuxtLink class="btn" to="/payments/history">Открыть историю покупок</NuxtLink></section></main></template>
<style scoped>.payment-return{display:grid;place-items:center;min-height:60vh}.payment-return .panel{max-width:620px;padding:2rem}.payment-return h1{margin:.3rem 0 1rem}.payment-return p{color:var(--text-muted);line-height:1.6}.eyebrow{color:var(--accent);font-size:.7rem;letter-spacing:.16em;font-weight:800}</style>
