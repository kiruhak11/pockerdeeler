<script setup lang="ts">
import { useAccountStore } from '~/stores/account'
import { usePlayerSessionStore } from '~/stores/playerSession'
import { useRoomStore } from '~/stores/room'
const props = defineProps<{ roomCode: string; dealer?: boolean }>()
const account = useAccountStore()
const room = useRoomStore()
const auth = useAccountAuth()
const credentials = usePlayerSessionStore()
type Choice = { id: string; name: string; available?: boolean; tokens?: number }
type Allocation = { candidateId: string; tokens: number; status: string; payout: number }
type State = { enabled?: boolean; round: { id: string; handNumber: number; status: string; accepting?: boolean; rewardFund: number; candidates: Choice[] } | null; budget?: number; allocations?: Allocation[]; history?: { id: string; handNumber: number; candidateName: string; status: string; tokens: number; payout: number }[] }
const state = ref<State | null>(null)
const draft = ref<Record<string, number>>({})
const busy = ref(false)
const error = ref('')
const total = computed(() => Object.values(draft.value).reduce((a,b)=>a+b,0))
const editable = computed(() => !props.dealer && state.value?.round?.accepting && !busy.value)
let generation = 0
async function load() {
  if (!props.dealer && !account.token) { state.value = null; return }
  const ticket = ++generation
  try {
    const token = props.dealer ? credentials.dealerSecret : account.token
    const result = await $fetch<State>(`/api/rooms/${props.roomCode}/tokens/${props.dealer ? 'dealer' : 'state'}`, { headers: { Authorization: `Bearer ${token}` } })
    if (ticket !== generation) return
    const oldRound = state.value?.round?.id
    const saved = Object.fromEntries((state.value?.allocations || []).map(a=>[a.candidateId,a.tokens]))
    const dirty = Object.entries(draft.value).some(([id,v])=>v!==(saved[id] || 0)) || Object.entries(saved).some(([id,v])=>v!==(draft.value[id] || 0))
    state.value = result
    if (oldRound !== result.round?.id || !result.round?.accepting || !dirty) draft.value = Object.fromEntries((result.allocations || []).map(a=>[a.candidateId,a.tokens]))
  } catch { if (ticket === generation) state.value = null }
}
function change(id: string, delta: number) {
  if (!editable.value || (delta > 0 && total.value >= 3)) return
  draft.value = { ...draft.value, [id]: Math.max(0,(draft.value[id] || 0)+delta) }
}
async function save() {
  if (!editable.value || !state.value?.round) return
  busy.value = true; error.value = ''
  try {
    state.value = await $fetch<State>(`/api/rooms/${props.roomCode}/tokens/allocate`, { method: 'POST', retry: 0, headers: { Authorization: `Bearer ${account.token}` }, body: { roundId: state.value.round.id, requestId: crypto.randomUUID(), allocations: Object.entries(draft.value).filter(([,tokens])=>tokens>0).map(([candidateId,tokens])=>({candidateId,tokens})) } })
  } catch (e: any) { error.value = e?.data?.statusMessage || 'Не удалось сохранить. Проверяем состояние.'; await load() }
  finally { busy.value = false }
}
watch(() => [props.roomCode, room.room?.revision, account.token], () => { if (!busy.value) void load() })
onMounted(async () => {
  credentials.loadSession()
  if (!props.dealer && !account.token) await auth.loadMe().catch(()=>null)
  await load()
})
</script>
<template>
  <section v-if="state?.round && state.enabled !== false" class="panel tokens">
    <header><div><small>ПРОГНОЗЫ · РАЗДАЧА {{ state.round.handNumber }}</small><h3>{{ dealer ? 'Жетоны на игроков' : 'Три жетона — ваш прогноз' }}</h3></div><b v-if="!dealer">{{ '●'.repeat(3-total) }}{{ '○'.repeat(total) }}</b></header>
    <p>{{ dealer ? 'Анонимные итоги: личности участников не раскрываются.' : state.round.accepting ? 'Распределите до трёх жетонов и сохраните до первого действия.' : 'Прогнозы зафиксированы. На следующую раздачу — новые жетоны.' }}</p>
    <div v-for="candidate in state.round.candidates" :key="candidate.id" class="candidate">
      <span>{{ candidate.name }}<small v-if="candidate.available === false"> · нельзя на себя</small></span>
      <b v-if="dealer">{{ candidate.tokens }} ●</b>
      <div v-else><button :disabled="!editable || !draft[candidate.id]" :aria-label="`Убрать жетон: ${candidate.name}`" @click="change(candidate.id,-1)">−</button><b>{{ draft[candidate.id] || 0 }}</b><button :disabled="!editable || total >= 3 || !candidate.available" :aria-label="`Добавить жетон: ${candidate.name}`" @click="change(candidate.id,1)">+</button></div>
    </div>
    <button v-if="state.round.accepting && !dealer" class="btn" :disabled="busy" @click="save">{{ busy ? 'Сохраняем…' : 'Сохранить прогноз' }}</button>
    <p class="rules">Награда удерживается из максимум 10% чистого выигрыша победителя и делится между правильными жетонами. Остаток округления остаётся победителю.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <details v-if="state.history?.length"><summary>Результаты прогнозов</summary><div v-for="item in state.history" :key="item.id" class="result"><span>#{{ item.handNumber }} · {{ item.candidateName }} · {{ item.tokens }} ●</span><b>{{ item.status === 'WON' ? '+' + item.payout : item.status === 'VOID' ? 'Отменён' : 'Не угадан' }}</b></div></details>
  </section>
</template>
<style scoped>.tokens{display:grid;gap:.7rem;margin:1rem 0;padding:1rem}.tokens header,.candidate,.result{display:flex;justify-content:space-between;gap:.7rem;align-items:center}.tokens h3,.tokens p{margin:.2rem 0}.tokens small,.rules{color:var(--text-muted)}header>b{color:var(--accent);letter-spacing:.2em}.candidate{padding:.6rem;background:#ffffff08;border-radius:12px}.candidate>div{display:flex;align-items:center;gap:.7rem}.candidate button{width:2rem;height:2rem;border:0;border-radius:8px;background:var(--accent);cursor:pointer}.candidate button:disabled{opacity:.35;cursor:default}.rules{font-size:.8rem}.result{padding:.5rem 0;font-size:.85rem}</style>
