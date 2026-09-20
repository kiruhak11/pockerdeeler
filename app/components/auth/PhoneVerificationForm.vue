<script setup lang="ts">
import type { PhonePurpose } from '~/types/account'
import { formatRussianPhone, normalizeRussianPhone, useAccountAuth } from '~/composables/useAccountAuth'
import { getHttpErrorMessage } from '~/utils/httpError'
import { maskRussianPhone } from '~/utils/phoneMask'
import { readPhoneFlow, writePhoneFlow, type SavedPhoneFlow } from './phoneFlowStorage'

const props = defineProps<{ purpose: PhonePurpose; storageKey?: string }>()
const emit = defineEmits<{ authenticated: [] }>()
const auth = useAccountAuth()
const key = computed(() => props.storageKey || 'poker-phone-flow-v1')
const saved = ref<SavedPhoneFlow | null>(null)
const phone = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const ageConfirmed = ref(false)
const termsAccepted = ref(false)
const privacyAcknowledged = ref(false)
const personalDataConsent = ref(false)
const busy = ref(false)
const error = ref('')
const checked = ref(false)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
let nextPoll = 0
let failures = 0
let disposed = false
const verification = computed(() => saved.value?.verification)
const expired = computed(() => !!verification.value && (Date.parse(verification.value.expiresAt) <= now.value || ['expired', 'failed', 'consumed'].includes(verification.value.status)))
const verified = computed(() => checked.value && verification.value?.status === 'verified' && !expired.value)
const secondsLeft = computed(() => verification.value ? Math.max(0, Math.ceil((Date.parse(verification.value.expiresAt) - now.value) / 1000)) : 0)
const callPhone = computed(() => /^\+?\d{10,15}$/.test(verification.value?.callPhone || '') ? verification.value!.callPhone : null)
const purpose = computed(() => saved.value?.purpose || props.purpose)

function persist() { writePhoneFlow(key.value, saved.value) }
function onPhoneInput(event: Event) {
  phone.value = maskRussianPhone((event.target as HTMLInputElement).value)
}
function done() {
  saved.value = null
  try { persist() } catch { /* The server session is already established. */ }
  password.value = ''
  confirmPassword.value = ''
  if (!disposed) emit('authenticated')
}
async function recoverCompletion() {
  if (!saved.value?.completing) return false
  const user = await auth.loadMe()
  if (user?.phoneVerified && user.phone === saved.value.phone) { done(); return true }
  return false
}
async function start() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!saved.value) {
      saved.value = { phone: normalizeRussianPhone(phone.value), purpose: props.purpose, requestId: crypto.randomUUID(), verification: null }
    }
    // Persist before sending: retries after a lost response reuse this exact request.
    persist()
    saved.value.verification = await auth.startPhone(saved.value.phone, saved.value.purpose, saved.value.requestId)
    checked.value = true
    persist()
    nextPoll = Date.now() + 5000
  } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось начать проверку. Повторите эту же заявку.') }
  finally { busy.value = false }
}
async function check() {
  if (busy.value || !verification.value) return
  busy.value = true
  try {
    if (await recoverCompletion()) return
    const result = await auth.phoneStatus(verification.value.id)
    if (!saved.value) return
    saved.value.verification = result
    checked.value = true
    persist()
    failures = 0
    error.value = ''
  } catch (e) {
    failures++
    error.value = getHttpErrorMessage(e, 'Не удалось проверить номер. Заявка сохранена.')
  } finally {
    nextPoll = Date.now() + Math.min(60000, 5000 * 2 ** failures)
    busy.value = false
  }
}
async function complete() {
  if (busy.value || !verified.value || !saved.value || !verification.value) return
  error.value = ''
  if (password.value !== confirmPassword.value) { error.value = 'Подтверждение пароля не совпадает'; return }
  if (purpose.value === 'register' && (!ageConfirmed.value || !termsAccepted.value || !privacyAcknowledged.value || !personalDataConsent.value)) {
    error.value = 'Для создания аккаунта подтвердите возраст и обязательные юридические документы'
    return
  }
  busy.value = true
  try {
    saved.value.completing = true
    persist()
    await auth.completePhone(verification.value.id, password.value, purpose.value === 'register' ? username.value.trim() : undefined, purpose.value === 'register' ? {
      ageConfirmed: ageConfirmed.value,
      termsAccepted: termsAccepted.value,
      privacyAcknowledged: privacyAcknowledged.value,
      personalDataConsent: personalDataConsent.value
    } : undefined)
    done()
  } catch (e) {
    error.value = getHttpErrorMessage(e, 'Ответ не получен. Проверьте результат, не создавая новую заявку.')
    try { await recoverCompletion() } catch { /* Keep the original attempt for recovery. */ }
  } finally { busy.value = false }
}
function reset() {
  if (busy.value) return
  saved.value = null
  checked.value = false
  password.value = ''
  confirmPassword.value = ''
  try { persist(); error.value = '' } catch { error.value = 'Не удалось очистить сохранённую заявку' }
}
function resume() {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    now.value = Date.now()
    if (verification.value) void check()
  }
}
onMounted(() => {
  saved.value = readPhoneFlow(key.value)
  if (saved.value) phone.value = maskRussianPhone(saved.value.phone)
  if (verification.value) void check()
  timer = setInterval(() => {
    now.value = Date.now()
    if (document.visibilityState === 'visible' && navigator.onLine && now.value >= nextPoll && verification.value && !expired.value && (!verified.value || saved.value?.completing)) void check()
  }, 1000)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('online', resume)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(timer)
  document.removeEventListener('visibilitychange', resume)
  window.removeEventListener('pageshow', resume)
  window.removeEventListener('online', resume)
})
</script>

<template>
  <section class="phone-flow" :aria-busy="busy">
    <p v-if="purpose === 'link'">Подтвердите свой номер и задайте новый пароль. История и баланс этого аккаунта сохранятся.</p>
    <p v-else-if="purpose === 'recover'">Подтвердите номер звонком, затем задайте новый пароль.</p>
    <p v-else>Аккаунт создаётся только после подтверждения вашего номера. Другие игроки увидят только никнейм.</p>
    <form v-if="!saved" class="phone-flow__form" @submit.prevent="start">
      <label>Российский номер телефона
        <input :value="phone" class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (___) ___-__-__" @input="onPhoneInput" required>
      </label>
      <button class="btn" :disabled="busy">{{ busy ? 'Создаём заявку...' : 'Подтвердить звонком' }}</button>
    </form>
    <template v-else-if="!verification">
      <p>Заявка для {{ formatRussianPhone(saved.phone) }} сохранена. Если ответ потерялся, повторите запрос с тем же идентификатором.</p>
      <button class="btn" :disabled="busy" @click="start">Восстановить эту заявку</button>
      <button class="btn btn--ghost" :disabled="busy" @click="reset">Исправить номер</button>
    </template>
    <template v-else>
      <p>Ваш номер: <strong>{{ formatRussianPhone(verification.phone) }}</strong></p>
      <template v-if="!expired && !verified">
        <p>Позвоните с указанного вами номера на этот номер:</p>
        <a v-if="callPhone" class="btn phone-flow__number" :href="`tel:${callPhone}`">{{ formatRussianPhone(callPhone) }}</a>
        <p v-else>Ожидаем номер для звонка. Не создавайте повторную заявку.</p>
        <p>При двух SIM выберите подтверждаемый номер. После возврата сюда мы продолжим ту же проверку.</p>
        <p role="status">{{ checked ? 'Ожидаем подтверждения сервера' : 'Проверяем сохранённую заявку' }}. Осталось {{ secondsLeft }} сек.</p>
      </template>
      <p v-if="expired" role="status">Проверка завершена или срок истёк. Для новой попытки нажмите «Начать заново».</p>
      <form v-if="verified" class="phone-flow__form" @submit.prevent="complete">
        <p class="phone-flow__success" role="status">Номер подтверждён сервером.</p>
        <label v-if="purpose === 'register'">Никнейм для игроков
          <input v-model="username" class="input" autocomplete="nickname" minlength="3" maxlength="32" required>
        </label>
        <label>Новый пароль (12–128 символов)
          <input v-model="password" class="input" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
        </label>
        <label>Повторите пароль
          <input v-model="confirmPassword" class="input" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
        </label>
        <fieldset v-if="purpose === 'register'" class="phone-flow__legal">
          <legend>Обязательные подтверждения</legend>
          <label><input v-model="ageConfirmed" type="checkbox" required> Мне исполнилось 18 лет</label>
          <label><input v-model="termsAccepted" type="checkbox" required> Я принимаю <a href="/legal/user-agreement" target="_blank" rel="noopener">Пользовательское соглашение</a></label>
          <label><input v-model="privacyAcknowledged" type="checkbox" required> Я ознакомился(лась) с <a href="/legal/privacy" target="_blank" rel="noopener">Политикой конфиденциальности</a></label>
          <label><input v-model="personalDataConsent" type="checkbox" required> Я даю отдельное <a href="/legal/personal-data-consent" target="_blank" rel="noopener">согласие на обработку персональных данных</a></label>
        </fieldset>
        <button class="btn" :disabled="busy">{{ busy ? 'Сохраняем...' : purpose === 'register' ? 'Создать аккаунт' : 'Сохранить номер и пароль' }}</button>
      </form>
      <button v-if="!verified || saved.completing" class="btn btn--ghost" :disabled="busy" @click="check">Проверить результат</button>
      <button class="btn btn--ghost" :disabled="busy" @click="reset">{{ expired ? 'Начать заново' : 'Исправить номер' }}</button>
    </template>
    <p v-if="error" class="phone-flow__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped lang="scss">
.phone-flow { display: grid; gap: 0.8rem; min-width: 0; p { margin: 0; color: var(--text-muted); line-height: 1.5; } &__form { display: grid; gap: 0.9rem; } label { display: grid; gap: 0.4rem; } &__number { font-size: 1.2rem; text-align: center; text-decoration: none; overflow-wrap: anywhere; } &__legal { display: grid; gap: 0.55rem; margin: 0; padding: 0.8rem; border: 1px solid color-mix(in srgb, var(--text-muted) 35%, transparent); border-radius: 0.6rem; } &__legal legend { padding: 0 0.25rem; color: var(--text); font-weight: 600; } &__legal label { display: flex; align-items: flex-start; gap: 0.5rem; line-height: 1.4; } &__legal input { flex: 0 0 auto; margin-top: 0.2rem; } &__legal a { overflow-wrap: anywhere; } p#{&}__error { color: var(--danger); } p#{&}__success { color: var(--success); } .btn { min-height: 46px; } }
</style>
