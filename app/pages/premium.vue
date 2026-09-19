<script setup lang="ts">
import LegalConsentFields from '~/components/legal/LegalConsentFields.vue'
import type { PremiumAccess, PremiumPlan } from '~/types/premium'
import AchievementBadge from '~/components/achievement/AchievementBadge.vue'
import PremiumBadge from '~/components/premium/PremiumBadge.vue'
import AppIcon from '~/components/ui/AppIcon.vue'

type PlanView = { plan: PremiumPlan; name: string; priceRub: number; durationDays: number; features: string[] }
type ConsentState = { termsAccepted: boolean; virtualCurrencyAcknowledged: boolean; ageConfirmed: boolean; personalDataConsent: boolean }

const plans = ref<PlanView[]>([])
const access = ref<PremiumAccess | null>(null)
const summary = ref<any>(null)
const selectedPlan = ref<PremiumPlan>('PRO')
const loading = ref(true)
const paying = ref(false)
const message = ref('')
const consents = ref<ConsentState>({ termsAccepted: false, virtualCurrencyAcknowledged: false, ageConfirmed: false, personalDataConsent: false })
const preferences = reactive({ theme: 'classic', frame: 'none', interfaceStyle: 'standard', nameColor: undefined as string | undefined, profilePreset: undefined as string | undefined, animatedFrame: false })

const labels: Record<string, string> = {
  PREMIUM_BADGE: 'Premium-значок', PREMIUM_FRAMES: 'Премиум-рамки', ADDITIONAL_THEMES: 'Дополнительные темы', EXTENDED_HISTORY: 'Расширенная история', BASIC_STATS: 'Базовая расширенная статистика', POKER_HANDS_GUIDE: 'Справочник покерных комбинаций', ROOM_CHAT: 'Чат в игровой комнате',
  ADVANCED_ANALYTICS: 'Расширенная аналитика', BALANCE_CHART: 'График изменения баланса', EXTENDED_POKER_STATS: 'Статистика покера', EXTENDED_MINIGAME_STATS: 'Статистика мини-игр', PREMIUM_ACHIEVEMENTS: 'Premium-достижения', VISUAL_SETTINGS: 'Визуальные настройки',
  ELITE_BADGE: 'Elite-значок', PREMIUM_NAME_COLOR: 'Премиум-цвет ника', ANIMATED_PROFILE_FRAME: 'Анимированная рамка', PROFILE_PRESETS: 'Пресеты профиля', EXTENDED_PROFILE_STYLE: 'Расширенное оформление профиля', LEADERBOARD_PREMIUM_FILTER: 'Premium-фильтр лидерборда'
}

const currentPlanName = computed(() => access.value?.plan ? `Premium ${access.value.plan[0] + access.value.plan.slice(1).toLowerCase()}` : 'Premium не активен')
const chosen = computed(() => plans.value.find(item => item.plan === selectedPlan.value))
const paymentLabel = computed(() => paying.value ? 'Создаём платёж…' : consents.value.termsAccepted ? `Оплатить ${chosen.value?.priceRub || 0} ₽` : 'Примите условия перед оплатой')

onMounted(async () => {
  try {
    const catalog = await $fetch<{ plans: PlanView[] }>('/api/premium/plans')
    plans.value = catalog.plans
    try {
      access.value = await $fetch<PremiumAccess>('/api/premium/me')
      if (access.value.active) {
        selectedPlan.value = access.value.plan || 'PRO'
        const [settingsResult, summaryResult] = await Promise.all([$fetch<any>('/api/premium/preferences'), $fetch<any>('/api/premium/summary')])
        Object.assign(preferences, settingsResult.settings || {})
        summary.value = summaryResult
      }
    } catch { access.value = null }
  } finally { loading.value = false }
})

async function savePreferences() {
  message.value = ''
  const body: Record<string, unknown> = { theme: preferences.theme, frame: preferences.frame }
  if (access.value?.features.includes('VISUAL_SETTINGS')) body.interfaceStyle = preferences.interfaceStyle
  if (access.value?.plan === 'ELITE') Object.assign(body, { nameColor: preferences.nameColor, profilePreset: preferences.profilePreset, animatedFrame: preferences.animatedFrame })
  await $fetch('/api/premium/preferences', { method: 'POST', body })
  document.documentElement.dataset.premiumTheme = preferences.theme
  if (access.value?.features.includes('VISUAL_SETTINGS')) document.documentElement.dataset.premiumSurface = preferences.interfaceStyle
  else delete document.documentElement.dataset.premiumSurface
  message.value = 'Настройки Premium сохранены'
}

async function startPremiumPayment() {
  if (!consents.value.termsAccepted || !chosen.value || paying.value) return
  paying.value = true
  message.value = ''
  try {
    await $fetch('/api/legal/accept', { method: 'POST', body: { context: 'PREMIUM', requestId: crypto.randomUUID(), termsAccepted: true } })
    const payment = await $fetch<{ confirmationUrl: string }>('/api/payments/premium/create', { method: 'POST', body: { plan: chosen.value.plan } })
    window.location.assign(payment.confirmationUrl)
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Не удалось создать платёж'
    paying.value = false
  }
}

useHead({ title: 'Premium · Poker Dealer Desk' })
</script>

<template>
  <main class="page-shell premium-page">
    <header class="premium-hero">
      <div class="premium-hero__copy"><p class="eyebrow">POKER DEALER DESK / PREMIUM</p><h1>Ваш стиль.<br><span>Ваша история игры.</span></h1><p class="lead">Больше аналитики и возможностей оформления — без игровых преимуществ.</p><div class="fairness"><b>✓</b><span><strong>Premium не влияет на вероятность выигрыша, рейтинг или результат игр.</strong><small>Механика покера, «Ракетки» и «Мин» остаётся одинаковой для всех.</small></span></div></div>
      <aside class="premium-state"><PremiumBadge :plan="access?.active ? access.plan : null" :size="64"/><div><span>Текущий статус</span><strong>{{ currentPlanName }}</strong><small v-if="access?.expiresAt">До {{ new Date(access.expiresAt).toLocaleDateString('ru-RU') }}</small><small v-else>Выберите подходящий тариф</small></div></aside>
    </header>

    <section aria-labelledby="premium-plans-title"><div class="section-heading"><div><p class="eyebrow">ТАРИФЫ</p><h2 id="premium-plans-title">30 дней Premium</h2></div><p>Без автоматического продления</p></div>
      <div v-if="loading" class="plans-loading">Загружаем тарифы…</div>
      <div v-else class="plans"><article v-for="item in plans" :key="item.plan" class="plan" :class="[`plan--${item.plan.toLowerCase()}`, { selected: selectedPlan === item.plan, current: access?.plan === item.plan }]"><div class="plan__top"><span class="plan__code">{{ item.plan }}</span><PremiumBadge :plan="item.plan" :size="52"/><span v-if="item.plan === 'PRO'" class="popular">Популярный</span><span v-else-if="access?.plan === item.plan" class="current-mark">Текущий</span></div><h3>{{ item.name }}</h3><div class="price"><strong>{{ item.priceRub }} ₽</strong><span>/ {{ item.durationDays }} дней</span></div><p class="renewal">Разовая покупка · без автопродления</p><ul><li v-for="feature in item.features" :key="feature"><i>✓</i><span>{{ labels[feature] }}</span></li></ul><button type="button" :aria-pressed="selectedPlan === item.plan" @click="selectedPlan = item.plan">{{ selectedPlan === item.plan ? 'Выбран' : 'Выбрать' }}</button></article></div>
    </section>

    <section class="checkout panel" aria-labelledby="premium-checkout-title"><div class="checkout__summary"><p class="eyebrow">ОФОРМЛЕНИЕ</p><h2 id="premium-checkout-title">{{ chosen?.name || 'Premium Pro' }}</h2><div><strong>{{ chosen?.priceRub || 299 }} ₽</strong><span>30 дней · без автопродления</span></div><p>Оплата проходит через ЮKassa. Premium активируется только после серверного подтверждения успешного платежа.</p><nav aria-label="Юридические документы Premium"><NuxtLink to="/legal/offer" target="_blank">Публичная оферта <AppIcon name="arrow-right" :size="14"/></NuxtLink><NuxtLink to="/legal/game-rules" target="_blank">Правила сервиса <AppIcon name="arrow-right" :size="14"/></NuxtLink><NuxtLink to="/legal/refunds" target="_blank">Условия возврата <AppIcon name="arrow-right" :size="14"/></NuxtLink></nav></div><div class="checkout__action"><LegalConsentFields v-model="consents" mode="PREMIUM" /><button type="button" :disabled="paying || !consents.termsAccepted" @click="startPremiumPayment">{{ paymentLabel }}</button><small>Галочка не отмечена заранее. Автопродления и сохранения карты нет.</small><span v-if="message" class="payment-message">{{ message }}</span></div></section>

    <section v-if="summary" class="premium-summary"><article><small>Баланс</small><strong>{{ summary.balance.toLocaleString('ru-RU') }}</strong></article><article><small>Покер</small><strong>{{ summary.poker.wins }} / {{ summary.poker.hands }}</strong></article><article><small>Мини-игры</small><strong>{{ summary.miniGames.rocketGames + summary.miniGames.minesGames }}</strong></article></section>
    <section v-if="access?.achievements.length" class="premium-achievements panel"><article v-for="achievement in access.achievements" :key="achievement.code"><AchievementBadge :code="achievement.code" :size="30"/><div><strong>{{ achievement.title }}</strong><small>{{ achievement.description }}</small></div></article></section>
    <section v-if="access?.active" class="premium-tools panel"><div><p class="eyebrow">ВАШ PREMIUM</p><h2>Оформление профиля</h2><small>Настройки сохраняются между подписками.</small></div><div class="settings"><label>Тема<select v-model="preferences.theme"><option value="classic">Классическая</option><option value="midnight">Midnight</option><option value="emerald">Emerald</option><option value="gold">Gold</option></select></label><label>Рамка<select v-model="preferences.frame"><option value="none">Без рамки</option><option value="gold">Gold</option><option value="emerald">Emerald</option><option value="obsidian">Obsidian</option></select></label><label v-if="access.features.includes('VISUAL_SETTINGS')">Контраст<select v-model="preferences.interfaceStyle"><option value="standard">Стандартный</option><option value="soft">Мягкий</option><option value="contrast">Высокий</option></select></label><label v-if="access.features.includes('PREMIUM_NAME_COLOR')">Цвет ника<select v-model="preferences.nameColor"><option value="gold">Золотой</option><option value="mint">Мятный</option><option value="violet">Фиолетовый</option></select></label><label v-if="access.features.includes('PROFILE_PRESETS')">Профиль<select v-model="preferences.profilePreset"><option value="classic">Classic</option><option value="royal">Royal</option><option value="neon">Neon</option></select></label><label v-if="access.features.includes('ANIMATED_PROFILE_FRAME')" class="check"><input v-model="preferences.animatedFrame" type="checkbox">Анимированная рамка</label></div><div class="actions"><button class="btn" @click="savePreferences">Сохранить</button><NuxtLink v-if="access.features.includes('ADVANCED_ANALYTICS')" class="btn btn--ghost" to="/premium/analytics">Открыть аналитику <AppIcon name="arrow-right" :size="17" /></NuxtLink><span>{{ message }}</span></div></section>
  </main>
</template>

<style scoped lang="scss">
.premium-page{display:grid;gap:1.35rem;padding-top:1.35rem}.eyebrow{margin:0;color:#dbba6d;font-size:.67rem;font-weight:800;letter-spacing:.18em}.premium-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:2rem;overflow:hidden;padding:clamp(1.4rem,4vw,3.3rem);border:1px solid #e8c77638;border-radius:32px;background:radial-gradient(circle at 86% 5%,#e9bf6538,transparent 28%),radial-gradient(circle at 6% 100%,#48a9761e,transparent 34%),linear-gradient(135deg,#183d2e,#091a14);box-shadow:0 28px 80px #0004}.premium-hero::after{content:'✦';position:absolute;right:9%;bottom:-42px;color:#e8c36b0e;font-size:15rem;line-height:1}.premium-hero__copy{position:relative;z-index:1}.premium-hero h1{margin:.7rem 0 .85rem;font-size:clamp(2.45rem,6vw,5.1rem);line-height:.94;letter-spacing:-.045em}.premium-hero h1 span{color:#8acaa8}.lead{max-width:650px;margin:0;color:#a8bdb2;line-height:1.55}.fairness{display:flex;align-items:flex-start;gap:.75rem;max-width:710px;margin-top:1.25rem;padding:.85rem 1rem;border:1px solid #77d39a31;border-radius:16px;background:#65bd8310}.fairness>b{display:grid;place-items:center;flex:0 0 27px;height:27px;border-radius:50%;color:#092016;background:#7ad49d}.fairness strong,.fairness small{display:block}.fairness strong{font-size:.87rem}.fairness small{margin-top:.3rem;color:#91aa9d;line-height:1.4}.premium-state{position:relative;z-index:1;align-self:start;padding:1rem;border:1px solid #ffffff18;border-radius:18px;background:#ffffff0b;backdrop-filter:blur(12px)}.premium-state span,.premium-state strong,.premium-state small{display:block}.premium-state span{color:#94aea1;font-size:.7rem;text-transform:uppercase;letter-spacing:.12em}.premium-state strong{margin:.4rem 0;font-size:1.1rem}.premium-state small{color:#dabc71}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:1rem;margin:0 .25rem .8rem}.section-heading h2{margin:.3rem 0 0;font-size:clamp(1.5rem,3vw,2.2rem)}.section-heading>p{margin:0;color:#96aea2;font-size:.8rem}.plans-loading{padding:3rem;text-align:center;color:var(--text-muted)}.plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem;align-items:stretch}.plan{position:relative;display:flex;flex-direction:column;min-width:0;padding:1.25rem;border:1px solid #ffffff17;border-radius:25px;background:linear-gradient(150deg,#173329,#0c2119);box-shadow:0 16px 45px #0002;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}.plan:hover{transform:translateY(-3px)}.plan--pro{border-color:#deb85f66;background:radial-gradient(circle at 85% 0,#dcb55d22,transparent 33%),linear-gradient(150deg,#1d3b2d,#10251c);box-shadow:0 22px 65px #d0a84a16}.plan.selected{border-color:#e2bd66;box-shadow:0 0 0 1px #e2bd6630,0 24px 65px #0003}.plan.current::after{content:'';position:absolute;inset:7px;border:1px solid #76c89940;border-radius:19px;pointer-events:none}.plan__top{display:flex;justify-content:space-between;align-items:center;gap:.5rem}.plan__code{color:#9db8aa;font-size:.67rem;letter-spacing:.18em}.popular,.current-mark{padding:.3rem .55rem;border-radius:999px;color:#192117;background:#e4bf68;font-size:.62rem;font-weight:900;text-transform:uppercase;letter-spacing:.04em}.current-mark{color:#b9e6cb;background:#59af7d22}.plan h3{margin:.8rem 0 .55rem;font-size:1.35rem}.price{display:flex;align-items:baseline;gap:.45rem}.price strong{color:#f0ca73;font-size:2rem}.price span{color:#99afa4;font-size:.75rem}.renewal{margin:.45rem 0 1rem;color:#81988d;font-size:.7rem}.plan ul{display:grid;gap:.52rem;margin:0 0 1.2rem;padding:0;list-style:none}.plan li{display:grid;grid-template-columns:20px 1fr;gap:.35rem;color:#b9cbbf;font-size:.78rem;line-height:1.35}.plan li i{display:grid;place-items:center;width:17px;height:17px;border-radius:50%;color:#163025;background:#85caa436;font-size:.64rem;font-style:normal}.plan>button{margin-top:auto;padding:.78rem;border:1px solid #ffffff18;border-radius:12px;color:#d6e2da;background:#ffffff0a;cursor:pointer;font-weight:800}.plan.selected>button{border-color:#e1ba60;color:#152018;background:#e1ba60}.checkout{display:grid;grid-template-columns:.9fr 1.1fr;gap:1.2rem;padding:1.2rem;border-color:#e3bd6138;background:radial-gradient(circle at 0 100%,#d2a94c13,transparent 30%),linear-gradient(145deg,#152f26,#0c2018)}.checkout__summary{padding:.35rem}.checkout__summary h2{margin:.35rem 0 1rem}.checkout__summary>div{display:flex;align-items:baseline;gap:.6rem}.checkout__summary>div strong{color:#f0ca73;font-size:2rem}.checkout__summary>div span,.checkout__summary>p{color:#94ab9f;font-size:.78rem;line-height:1.5}.checkout__summary nav{display:flex;gap:.45rem;flex-wrap:wrap;margin-top:1rem}.checkout__summary nav a{padding:.42rem .58rem;border-radius:9px;color:#d9bd78;background:#ffffff09;font-size:.7rem;text-decoration:none}.checkout__action{display:grid;gap:.75rem;padding:1rem;border:1px solid #ffffff13;border-radius:18px;background:#071b15}.checkout__action>button{padding:.9rem;border:0;border-radius:13px;color:#83958c;background:#ffffff0c;font-weight:800}.checkout__action>small{color:#789085;line-height:1.45}.premium-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem}.premium-summary article{display:grid;gap:.35rem;padding:1rem;border:1px solid #ffffff14;border-radius:18px;background:#ffffff07}.premium-summary small{color:var(--text-muted)}.premium-summary strong{font-size:1.45rem}.premium-achievements{display:flex;gap:.7rem;flex-wrap:wrap}.premium-achievements article{display:flex;align-items:center;gap:.65rem;min-width:220px;padding:.65rem;border-radius:14px;background:#ffffff08}.premium-achievements article>b{font-size:1.4rem;color:#e6c16e}.premium-achievements strong,.premium-achievements small{display:block}.premium-achievements small{margin-top:.2rem;color:var(--text-muted)}.premium-tools{display:grid;gap:1.2rem}.premium-tools h2{margin:.3rem 0}.premium-tools small{color:var(--text-muted)}.settings{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem}.settings label{display:grid;gap:.4rem;color:var(--text-muted);font-size:.76rem}.settings select{padding:.7rem;border:1px solid #ffffff19;border-radius:11px;color:inherit;background:#10251d}.settings .check{display:flex;align-items:center;gap:.5rem}.actions{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}.actions a{text-decoration:none}.actions span{color:#84d5a6;font-size:.78rem}
@media(max-width:850px){.premium-hero{grid-template-columns:1fr}.premium-state{width:min(100%,380px)}.plans{grid-template-columns:1fr}.plan:hover{transform:none}.checkout{grid-template-columns:1fr}.settings{grid-template-columns:1fr 1fr}}
.premium-state{display:flex;align-items:center;gap:.8rem}.plan__top{min-height:52px}.plan__top>.premium-badge{margin-left:auto}
@media(max-width:520px){.premium-page{gap:1rem;padding:.7rem .75rem 1.2rem}.premium-hero{padding:1.15rem;border-radius:23px}.premium-hero h1{font-size:2.7rem}.fairness{padding:.75rem}.section-heading{align-items:flex-start;flex-direction:column}.plan{padding:1.05rem;border-radius:21px}.checkout{padding:.75rem}.checkout__action{padding:.75rem}.checkout__summary nav{display:grid}.premium-summary,.settings{grid-template-columns:1fr}.price strong{font-size:1.8rem}}
</style>
