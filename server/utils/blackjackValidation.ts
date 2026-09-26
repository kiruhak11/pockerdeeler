import { z } from 'zod'

export const blackjackStartSchema = z.object({
  stake: z.number().int().min(2).max(2_000_000_000).refine(Number.isSafeInteger).refine(value => value % 2 === 0, 'Ставка должна быть чётной для точной выплаты 3:2'),
  requestId: z.string().uuid()
})

export const blackjackActionSchema = z.object({
  roundId: z.string().uuid(),
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative()
})

export type BlackjackStartInput = z.infer<typeof blackjackStartSchema>
export type BlackjackActionInput = z.infer<typeof blackjackActionSchema>
