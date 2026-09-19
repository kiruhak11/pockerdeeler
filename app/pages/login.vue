<script setup lang="ts">
import PhoneVerificationForm from '~/components/auth/PhoneVerificationForm.vue'
import { readPhoneFlow } from '~/components/auth/phoneFlowStorage'
import { normalizeRussianPhone, useAccountAuth } from '~/composables/useAccountAuth'
import { useAccountStore } from '~/stores/account'
import { getHttpErrorMessage } from '~/utils/httpError'
import { maskRussianPhone } from '~/utils/phoneMask'

const route = useRoute()
const account = useAccountStore()
const { login, loadMe } = useAccountAuth()
const mode = ref<'login' | 'register' | 'recover' | 'legacy'>('login')
const identity = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const returnPath = computed(() => {
  const path = typeof route.query.redirect === 'string' ? route.query.redirect : '/profile'
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n]/.test(path) && !path.startsWith('/login') ? path : '/profile'
})
async function authenticated() {
  password.value = ''
  await navigateTo(account.user?.mustChangePassword || !account.user?.phoneVerified ? '/profile' : returnPath.value)
}
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await login(mode.value === 'legacy' ? identity.value.trim() : normalizeRussianPhone(identity.value), password.value)
    await authenticated()
  } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось войти') }
  finally { busy.value = false }
}
function select(next: typeof mode.value) {
  mode.value = next
  password.value = ''
  error.value = ''
}
function onIdentityInput(event: Event) {
  identity.value = maskRussianPhone((event.target as HTMLInputElement).value)
}
onMounted(async () => {
  const pending = readPhoneFlow('poker-phone-flow-v1')
  if (pending && pending.purpose !== 'link') mode.value = pending.purpose
  else if (route.query.mode === 'register' || route.query.mode === 'recover') mode.value = route.query.mode
  try {
    await loadMe()
    if (account.user && !pending) await authenticated()
  } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось проверить сессию. Можно повторить вход.') }
})
</script>

<template>
  <main class="page-shell login-page">
    <section class="login-page__card">
      <div class="login-page__brand"><span class="login-page__mark">♠</span><div><strong>Poker Dealer Desk</strong><small>Живые карты. Общий стол.</small></div></div>
      <div class="login-page__intro"><span class="eyebrow">Ваш игровой профиль</span><h1>{{ mode === 'register' ? 'Создайте аккаунт' : mode === 'recover' ? 'Верните доступ' : 'Войдите в игру' }}</h1><p>Сохраняйте баланс, рейтинг и достижения в каждой игре.</p></div>
      <nav class="login-page__tabs" aria-label="Доступ к аккаунту">
        <button class="btn" :class="{ 'btn--ghost': mode !== 'login' }" :aria-pressed="mode === 'login'" :disabled="busy" @click="select('login')">Вход</button>
        <button class="btn" :class="{ 'btn--ghost': mode !== 'register' }" :aria-pressed="mode === 'register'" :disabled="busy" @click="select('register')">Регистрация</button>
      </nav>
      <PhoneVerificationForm v-if="mode === 'register' || mode === 'recover'" :key="mode" :purpose="mode" @authenticated="authenticated" />
      <form v-else class="login-page__form" @submit.prevent="submit">
        <p v-if="mode === 'legacy'" class="page-subtitle">Для старого аккаунта: войдите по прежнему нику и паролю, затем привяжите телефон в профиле. Баланс и история сохранятся.</p>
        <label>{{ mode === 'legacy' ? 'Прежний никнейм' : 'Российский номер телефона' }}
          <input v-if="mode === 'legacy'" v-model="identity" class="input" type="text" inputmode="text" autocomplete="username" placeholder="Ваш никнейм" required>
          <input v-else :value="identity" class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" @input="onIdentityInput" required>
        </label>
        <label>Пароль
          <input v-model="password" class="input" type="password" autocomplete="current-password" maxlength="128" required>
        </label>
        <button class="btn" :disabled="busy">{{ busy ? 'Входим...' : 'Войти' }}</button>
      </form>
      <p v-if="error" class="login-page__error" role="alert">{{ error }}</p>
      <button class="btn btn--ghost" :disabled="busy" @click="select('recover')">Забыли пароль?</button>
      <button class="btn btn--ghost" :disabled="busy" @click="select('legacy')">У меня старый аккаунт без телефона</button>
      <NuxtLink class="login-page__guest" to="/rooms">Продолжить как гость</NuxtLink>
    </section>
  </main>
</template>

<style scoped lang="scss">
.login-page { max-width: 820px; padding-block: 2rem 4rem; &__card { display: grid; gap: 1.4rem; padding: clamp(1.2rem, 4vw, 2.4rem); border: 1px solid rgba(242,180,81,.3); border-radius: 30px; background: linear-gradient(145deg, rgba(16,55,40,.98), rgba(10,29,23,.98)); box-shadow: 0 24px 70px #0007; } &__brand { display:flex; align-items:center; gap:.8rem; color:var(--text-primary); strong, small { display:block; } small { margin-top:.15rem; color:var(--text-muted); font-size:.8rem; } } &__mark { display:grid; place-items:center; width:48px; height:48px; border:1px solid var(--accent); border-radius:16px; color:var(--accent); background:#092219; font-size:2rem; } &__intro { max-width: 580px; h1 { margin:.35rem 0 .4rem; font-size:clamp(2rem, 6vw, 3.5rem); letter-spacing:-.04em; } p { margin:0; color:var(--text-muted); font-size:1.05rem; } } &__form { display:grid; gap:1rem; min-width:0; } &__tabs { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; padding:.35rem; border-radius:16px; background:#071810; } label { display:grid; gap:.4rem; } &__error { color:var(--danger); margin:0; } &__guest { text-align:center; padding:.6rem; } .btn { min-height:50px; } }
@media (max-width: 600px) { .login-page { padding: .8rem .7rem 3rem; &__card { border-radius:24px; } } }
</style>
