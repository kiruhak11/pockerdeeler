import { z } from 'zod'

export const minesStakeSchema = z.number().int().min(1).refine(Number.isSafeInteger)

export const minesStartInputSchema = z.object({
  stake: minesStakeSchema,
  mines: z.number().int().min(1).max(24),
  clientSeed: z.string().min(1).max(128),
  commitmentId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128)
})

export type MinesStartInput = z.infer<typeof minesStartInputSchema>
