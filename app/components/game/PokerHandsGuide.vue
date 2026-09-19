<script setup lang="ts">
const opened = ref(false)
const premiumEnabled = ref(false)
const dialog = ref<HTMLDialogElement | null>(null)
type Card = { value: string; suit: string; red?: boolean }
const c = (value: string, suit: string, red = false): Card => ({ value, suit, red })
const hands = [
  { name: 'Роял-флеш', cards: [c('A','♠'),c('K','♠'),c('Q','♠'),c('J','♠'),c('10','♠')], compare: 'Лучшая возможная комбинация.' },
  { name: 'Стрит-флеш', cards: [c('9','♥',true),c('8','♥',true),c('7','♥',true),c('6','♥',true),c('5','♥',true)], compare: 'Сравнивают старшую карту.' },
  { name: 'Каре', cards: [c('Q','♣'),c('Q','♦',true),c('Q','♥',true),c('Q','♠'),c('7','♦',true)], compare: 'Сначала каре, затем кикер.' },
  { name: 'Фулл-хаус', cards: [c('J','♠'),c('J','♥',true),c('J','♦',true),c('8','♣'),c('8','♥',true)], compare: 'Сначала тройка, затем пара.' },
  { name: 'Флеш', cards: [c('A','♦',true),c('J','♦',true),c('8','♦',true),c('5','♦',true),c('2','♦',true)], compare: 'Пять карт одной масти.' },
  { name: 'Стрит', cards: [c('10','♣'),c('9','♦',true),c('8','♠'),c('7','♥',true),c('6','♣')], compare: 'Пять последовательных карт.' },
  { name: 'Сет / трипс', cards: [c('7','♣'),c('7','♦',true),c('7','♥',true),c('K','♠'),c('4','♣')], compare: 'Тройка, затем кикеры.' },
  { name: 'Две пары', cards: [c('A','♠'),c('A','♥',true),c('6','♣'),c('6','♦',true),c('Q','♠')], compare: 'Старшая пара, младшая, кикер.' },
  { name: 'Одна пара', cards: [c('10','♠'),c('10','♥',true),c('A','♣'),c('8','♦',true),c('3','♠')], compare: 'Пара, затем три кикера.' },
  { name: 'Старшая карта', cards: [c('A','♠'),c('J','♥',true),c('9','♣'),c('5','♦',true),c('2','♠')], compare: 'Сравнивают все пять карт.' }
]
watch(opened, async value => { await nextTick(); if (value && !dialog.value?.open) dialog.value?.showModal(); if (!value && dialog.value?.open) dialog.value.close() })
function close() { opened.value = false }
onMounted(async () => {
  try {
    const access = await $fetch<{ features: string[] }>('/api/premium/me')
    premiumEnabled.value = access.features.includes('POKER_HANDS_GUIDE')
  } catch { premiumEnabled.value = false }
})
</script>
<template>
  <Teleport v-if="premiumEnabled" to="body">
    <button class="hands-guide-launcher" type="button" aria-label="Открыть справочник покерных комбинаций" title="Комбинации" @click="opened = true"><span>?</span><small>Комбинации</small></button>
    <dialog ref="dialog" class="hands-guide" aria-labelledby="hands-guide-title" @cancel.prevent="close" @click="event => { if (event.target === dialog) close() }">
      <section class="hands-guide__sheet"><header><div><span class="eyebrow">Шпаргалка за столом</span><h2 id="hands-guide-title">Покерные комбинации</h2></div><button type="button" aria-label="Закрыть" @click="close">×</button></header>
        <ol><li v-for="(hand,index) in hands" :key="hand.name"><span class="hands-guide__rank">{{ index + 1 }}</span><div class="hand-copy"><strong>{{ hand.name }}</strong><div class="hand-cards"><span v-for="(card,cardIndex) in hand.cards" :key="`${hand.name}-${cardIndex}`" class="playing-card" :class="{ 'playing-card--red': card.red }"><b>{{ card.value }}</b><i>{{ card.suit }}</i></span></div><small>{{ hand.compare }}</small></div></li></ol>
        <p class="hands-guide__kicker"><strong>Кикер</strong> — дополнительная старшая карта при равных комбинациях.</p>
      </section>
    </dialog>
  </Teleport>
</template>
<style scoped lang="scss">
.hands-guide-launcher{position:fixed;z-index:1100;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(88px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:.45rem;min-width:48px;height:48px;padding:0 .8rem;border:1px solid var(--accent);border-radius:999px;color:#142119;background:var(--accent);font:800 1.45rem 'Space Grotesk',sans-serif;box-shadow:0 8px 24px #0008,0 0 0 3px #f2b4511f;cursor:pointer;isolation:isolate}.hands-guide-launcher small{font:800 .72rem 'Space Grotesk',sans-serif}
.hands-guide{z-index:1200;width:min(760px,calc(100vw - 20px));max-height:calc(100dvh - 24px);padding:0;border:1px solid #f2b45166;border-radius:28px;color:var(--text-primary);background:linear-gradient(145deg,#173d2b,#0d2119);box-shadow:0 30px 100px #000b}.hands-guide::backdrop{background:#020d09c7;backdrop-filter:blur(5px)}
.hands-guide__sheet{padding:1rem}.hands-guide__sheet header{display:flex;justify-content:space-between;align-items:center;padding:.3rem .25rem 1rem}.hands-guide__sheet h2{margin:.2rem 0 0;font-size:clamp(1.35rem,4vw,2rem)}.hands-guide__sheet header button{width:44px;height:44px;border:1px solid #ffffff24;border-radius:50%;color:inherit;background:#ffffff0a;font-size:1.6rem;cursor:pointer}.hands-guide__sheet ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin:0;padding:0;list-style:none}.hands-guide__sheet li{display:grid;grid-template-columns:2rem 1fr;gap:.55rem;padding:.7rem;border:1px solid #ffffff12;border-radius:16px;background:#ffffff0b}.hand-copy{min-width:0}.hands-guide__sheet li strong{display:block;font-size:1rem}.hands-guide__sheet li small{display:block;color:var(--text-muted);line-height:1.3;font-size:.76rem}.hands-guide__rank{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;color:#132118;background:var(--accent);font-weight:800}.hand-cards{display:flex;gap:.2rem;margin:.45rem 0}.playing-card{display:flex;flex-direction:column;align-items:center;justify-content:center;width:34px;height:46px;border-radius:6px;color:#17221b;background:#f4f1e9;box-shadow:0 2px 5px #0006;font-family:Georgia,serif;line-height:1}.playing-card b{font-size:.85rem}.playing-card i{font-style:normal;font-size:1rem}.playing-card--red{color:#c33b37}.hands-guide__kicker{margin:.8rem 0 0;padding:.8rem;border:1px solid #f2b45159;border-radius:16px;color:var(--text-muted)}
@media(max-width:600px){.hands-guide-launcher{width:50px;min-width:50px;height:50px;padding:0;justify-content:center}.hands-guide-launcher small{display:none}.hands-guide{height:min(88dvh,820px);margin:auto auto 0;border-radius:24px 24px 0 0}.hands-guide__sheet{height:100%;overflow-y:auto;padding-bottom:calc(1rem + env(safe-area-inset-bottom))}.hands-guide__sheet ol{grid-template-columns:1fr}.hands-guide__sheet li{padding:.8rem}.playing-card{width:38px;height:50px}}
</style>
