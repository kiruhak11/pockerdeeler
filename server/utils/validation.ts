import { z } from 'zod'

const quickBetStepsSchema = z.array(z.number().int().positive().max(1_000_000)).min(1).max(10)

export const createRoomSchema = z.object({
  name: z.string().min(2).max(80),
  startingStack: z.number().int().positive().max(1_000_000),
  smallBlind: z.number().int().positive().optional(),
  bigBlind: z.number().int().positive().optional(),
  maxPlayers: z.number().int().min(2).max(10),
  quickBetSteps: quickBetStepsSchema.optional(),
  allowLateJoin: z.boolean(),
  requireDealerActionApproval: z.boolean(),
  allowSpectators: z.boolean()
})

export const joinRoomSchema = z.object({
  name: z.string().min(1).max(32),
  role: z.enum(['player', 'spectator']).optional()
})

export const playerActionSchema = z.object({
  playerId: z.string().uuid(),
  token: z.string().min(8),
  type: z.enum(['check', 'bet', 'call', 'raise', 'fold', 'all-in']),
  amount: z.number().int().nonnegative().default(0),
  clientRequestId: z.string().min(3).max(128)
})

export const dealerSecretSchema = z.object({
  dealerSecret: z.string().min(8)
})

export const dealerActionSchema = z.object({
  dealerSecret: z.string().min(8),
  pendingActionId: z.string().uuid(),
  decision: z.enum(['approve', 'reject'])
})

export const distributePotSchema = z.object({
  dealerSecret: z.string().min(8),
  winners: z.array(z.string().uuid()).min(1)
})

export const updateRoomSettingsSchema = z.object({
  dealerSecret: z.string().min(8),
  startingStack: z.number().int().positive().max(1_000_000).optional(),
  smallBlind: z.number().int().positive().optional(),
  bigBlind: z.number().int().positive().optional(),
  maxPlayers: z.number().int().min(2).max(10).optional(),
  quickBetSteps: quickBetStepsSchema.optional(),
  allowLateJoin: z.boolean().optional(),
  requireDealerActionApproval: z.boolean().optional(),
  allowSpectators: z.boolean().optional()
})
