<script setup lang="ts">
defineProps<{ history: { balance: number; entries: Array<{ id: string; entryType: string; amount: number; balanceAfter: number; createdAt: string; metadata?: Record<string, any> }> } | null; loading?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const labels: Record<string, string> = {
  JACKPOT_PRIZE: 'Приз сезонного джекпота',
  ROOM_STACK_RETURN: 'Возврат из стека', PREDICTION_REWARD: 'Награда за прогноз', MINES_STAKE: 'Ставка в Минах', MINES_PAYOUT: 'Выигрыш в Минах', MINES_LOSS: 'Проигрыш в Минах', MINES_BANK_RESERVE: 'Резерв выплат Mines', MINES_BANK_SETTLEMENT: 'Расчёт игрового банка Mines',
  SEASON_RESET: 'Переход в новый сезон', ADMIN_ADJUSTMENT: 'Изменение администратором', FRIEND_TRANSFER_DEBIT: 'Перевод другу', FRIEND_TRANSFER_CREDIT: 'Перевод от друга',
  BUY_IN_DEBIT: 'Вход за игровой стол', TABLE_CASH_OUT: 'Выход из-за стола', ROOM_CANCEL_REFUND: 'Возврат из отменённой игры', TOP_UP_DEBIT: 'Пополнение стека стола',
  CRASH_STAKE: 'Ставка в Ракете', CRASH_PAYOUT: 'Выигрыш в Ракете', ACHIEVEMENT_REWARD: 'Награда за достижение', SELF_PROMO_REWARD: 'Бонус', ACCOUNT_OPENING_GRANT: 'Стартовый баланс', OPENING_BALANCE: 'Начальный баланс'
}
const format = (value: number) => Math.abs(value).toLocaleString('ru-RU')
const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
</script>

<template>
  <Teleport to="body"><div class="wallet-backdrop" @click.self="emit('close')"><section class="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-history-title">
    <header><div><small>ДВИЖЕНИЕ ФИШЕК</small><h2 id="wallet-history-title">История баланса</h2></div><button aria-label="Закрыть" @click="emit('close')">×</button></header>
    <div class="wallet-modal__balance"><span>Текущий баланс</span><strong>{{ history?.balance.toLocaleString('ru-RU') || '—' }}</strong></div>
    <p v-if="loading">Загружаем операции…</p>
    <ol v-else-if="history?.entries.length" class="wallet-history">
      <li v-for="entry in history.entries" :key="entry.id"><span class="wallet-history__sign" :class="entry.amount >= 0 ? 'is-plus' : 'is-minus'">{{ entry.amount >= 0 ? '+' : '−' }}</span><div><strong>{{ entry.entryType === 'MINES_STAKE' && entry.metadata?.outcome === 'LOST' ? 'Мины: ставка проиграна' : labels[entry.entryType] || entry.entryType }}</strong><small>{{ date(entry.createdAt) }} · баланс {{ entry.balanceAfter.toLocaleString('ru-RU') }}</small><small v-if="entry.metadata?.roomCode">{{ entry.metadata.roomName }} · {{ entry.metadata.roomCode }}</small><small v-if="entry.entryType === 'SEASON_RESET'">Сезон {{ entry.metadata?.seasonNumber }} · было {{ Number(entry.metadata?.previousBalance || 0).toLocaleString('ru-RU') }}</small></div><b :class="entry.amount >= 0 ? 'is-plus' : 'is-minus'">{{ entry.amount >= 0 ? '+' : '−' }}{{ format(entry.amount) }}</b></li>
    </ol>
    <p v-else class="wallet-modal__empty">Операций пока нет.</p>
  </section></div></Teleport>
</template>

<style scoped lang="scss">
.wallet-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:1rem;background:#000c;backdrop-filter:blur(8px)}.wallet-modal{width:min(100%,620px);max-height:calc(100vh - 2rem);overflow:auto;padding:1.3rem;border:1px solid rgba(242,180,81,.3);border-radius:24px;background:#0c2118;color:var(--text-primary);box-shadow:0 28px 80px #000c}.wallet-modal header{display:flex;justify-content:space-between;align-items:flex-start}.wallet-modal header small{color:var(--accent);font-weight:900;letter-spacing:.1em}.wallet-modal h2{margin:.15rem 0}.wallet-modal header button{border:0;background:transparent;color:var(--text-muted);font-size:2rem;cursor:pointer}.wallet-modal__balance{display:flex;justify-content:space-between;align-items:center;margin:.8rem 0;padding:.85rem 1rem;border-radius:15px;background:rgba(242,180,81,.1)}.wallet-modal__balance strong{color:var(--accent);font-size:1.35rem}.wallet-history{display:grid;gap:.45rem;margin:0;padding:0;list-style:none}.wallet-history li{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:.7rem;padding:.7rem;border-radius:14px;background:#ffffff08}.wallet-history__sign{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:#ffffff0b;font-weight:900}.wallet-history strong,.wallet-history small{display:block}.wallet-history small{margin-top:.15rem;color:var(--text-muted);font-size:.7rem}.wallet-history b{font-size:.9rem}.is-plus{color:#72d395}.is-minus{color:#ff8b82}.wallet-modal__empty{color:var(--text-muted)}
</style>
