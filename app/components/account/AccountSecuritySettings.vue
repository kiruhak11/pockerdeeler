<script setup lang="ts">
import { formatRussianPhone, useAccountAuth } from '~/composables/useAccountAuth'
import { useAccountStore } from '~/stores/account'
import PhoneVerificationForm from '~/components/auth/PhoneVerificationForm.vue'
import { getHttpErrorMessage } from '~/utils/httpError'
import AppIcon from '~/components/ui/AppIcon.vue'
const accountStore = useAccountStore()
const { updateUsername, loadMe, changePassword } = useAccountAuth()
const username = ref(''); const loading = ref(false); const error = ref(''); const success = ref('')
const password = reactive({ current: '', next: '', confirm: '' })
async function updateName() { loading.value = true; error.value = ''; try { const user = await updateUsername(username.value); username.value = user.username; success.value = 'Имя пользователя обновлено' } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось обновить имя') } finally { loading.value = false } }
async function updatePassword() { error.value = ''; success.value = ''; if (password.next !== password.confirm) { error.value = 'Подтверждение пароля не совпадает'; return }; loading.value = true; try { await changePassword(password.current, password.next); await loadMe(); Object.assign(password, { current: '', next: '', confirm: '' }); success.value = 'Пароль успешно изменён' } catch (e) { error.value = getHttpErrorMessage(e, 'Не удалось изменить пароль') } finally { loading.value = false } }
onMounted(() => { username.value = accountStore.user?.username || '' })
</script>
<template>
  <section v-if="accountStore.user" class="profile-block account-security" aria-labelledby="account-security-title">
    <div class="profile-block__heading"><div><p class="section-kicker">АККАУНТ</p><h2 id="account-security-title">Профиль и безопасность</h2></div><span class="block-note">Личные данные</span></div>
    <div class="account-settings-grid"><div class="username-card"><div><strong>Отображаемое имя</strong><small>Его видят игроки в комнате и лидерборде.</small></div><div class="profile-page__row"><input v-model="username" class="input" type="text" placeholder="Имя пользователя" aria-label="Имя пользователя" minlength="3" maxlength="32"><button type="button" class="btn" :disabled="loading || !username.trim()" @click="updateName">Сохранить</button></div></div><div v-if="!accountStore.user.phoneVerified" class="phone-verification"><h3>Подтвердить телефон</h3><PhoneVerificationForm purpose="link" :storage-key="`poker-phone-link-v1:${accountStore.user.id}`" @authenticated="loadMe" /></div><div v-else class="account-status"><AppIcon name="check" :size="22"/><div><strong>Телефон подтверждён</strong><small>{{ formatRussianPhone(accountStore.user.phone) }}</small></div><NuxtLink class="text-action" to="/settings">Открыть настройки <AppIcon name="arrow-right" :size="16" /></NuxtLink></div></div>
    <div v-if="error" class="message message--error">{{ error }}</div><div v-if="success" class="message message--success">{{ success }}</div>
    <div class="password-grid"><label>Текущий пароль<input v-model="password.current" class="input" type="password" autocomplete="current-password"></label><label>Новый пароль<input v-model="password.next" class="input" type="password" autocomplete="new-password" minlength="12"></label><label>Повторите пароль<input v-model="password.confirm" class="input" type="password" autocomplete="new-password" minlength="12"></label></div><button class="btn" :disabled="loading || !password.current || password.next.length < 12 || !password.confirm" @click="updatePassword">Обновить пароль</button>
  </section>
</template>
<style scoped lang="scss">
.account-security{display:grid;gap:1rem}.account-settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.username-card,.phone-verification,.account-status{min-width:0;padding:1rem;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:rgba(255,255,255,.035)}.username-card{display:grid;gap:.8rem}.username-card strong,.username-card small{display:block}.username-card small{margin-top:.25rem;color:var(--text-muted);font-size:.76rem}.phone-verification h3{margin:0 0 .7rem;font-size:.95rem}.account-status{display:flex;align-items:center;gap:.75rem}.account-status svg{flex:none;color:#72d395}.account-status div{display:grid;gap:.18rem;min-width:0}.account-status small{color:var(--text-muted)}.account-status .text-action{margin-left:auto}.password-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.65rem}.password-grid label{display:grid;gap:.35rem;color:var(--text-muted);font-size:.82rem}.message{padding:.65rem;border-radius:12px}.message--error{color:var(--danger);background:#e5585814}.message--success{color:var(--success);background:#5ac48214}@media(max-width:620px){.account-settings-grid,.password-grid{grid-template-columns:1fr}}
</style>
