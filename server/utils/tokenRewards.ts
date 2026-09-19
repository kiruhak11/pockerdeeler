export type RewardTicket = { id: string; candidateId: string; tokens: number }
export function allocateTokenRewards(winners: Array<{ id: string; netProfit: number }>, tickets: RewardTicket[]) {
  const payouts = new Map<string, bigint>()
  const deductions = new Map<string, bigint>()
  for (const winner of winners) {
    const correct = tickets.filter(ticket => ticket.candidateId === winner.id)
    const tokens = correct.reduce((sum, ticket) => sum + ticket.tokens, 0)
    const fund = BigInt(Math.max(0, Math.trunc(winner.netProfit))) / 10n
    let paid = 0n
    for (const ticket of correct) {
      const payout = tokens ? fund * BigInt(ticket.tokens) / BigInt(tokens) : 0n
      payouts.set(ticket.id, payout); paid += payout
    }
    deductions.set(winner.id, paid)
  }
  return { payouts, deductions, total: [...deductions.values()].reduce((sum, amount) => sum + amount, 0n) }
}
