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
  allowSpectators: z.boolean(),
  authToken: z.string().min(16).optional()
})

export const joinRoomSchema = z.object({
  name: z.string().min(1).max(32),
  role: z.enum(['player', 'spectator']).optional(),
  authToken: z.string().min(16).optional()
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

export const registerSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(128)
})

export const loginSchema = registerSchema

export const authTokenSchema = z.object({
  token: z.string().min(16)
})

export const resetBalanceSchema = z.object({
  token: z.string().min(16),
  roomCode: z.string().min(3).max(8).optional(),
  playerId: z.string().uuid().optional()
})

export const dealerForceActionSchema = z.object({
  dealerSecret: z.string().min(8),
  playerId: z.string().uuid(),
  type: z.enum(['check', 'bet', 'call', 'raise', 'fold', 'all-in']),
  amount: z.number().int().nonnegative().default(0)
})

export const dealerKickPlayerSchema = z.object({
  dealerSecret: z.string().min(8),
  playerId: z.string().uuid()
})

export const updateUsernameSchema = z.object({
  token: z.string().min(16),
  username: z.string().min(3).max(32)
})

export const changePasswordSchema = z.object({
  token: z.string().min(16),
  currentPassword: z.string().min(6).max(128),
  newPassword: z.string().min(6).max(128)
})

export const sendFriendRequestSchema = z.object({
  token: z.string().min(16),
  username: z.string().min(3).max(32)
})

export const respondFriendRequestSchema = z.object({
  token: z.string().min(16),
  requestId: z.string().uuid(),
  decision: z.enum(['accept', 'reject'])
})

export const inviteFriendToRoomSchema = z.object({
  token: z.string().min(16),
  friendUserId: z.string().uuid()
})

export const respondRoomInviteSchema = z.object({
  token: z.string().min(16),
  inviteId: z.string().uuid(),
  decision: z.enum(['accept', 'decline'])
})

export const roomChatMessageSchema = z.object({
  message: z.string().min(1).max(300),
  participantId: z.string().uuid().optional(),
  token: z.string().min(8).optional(),
  dealerSecret: z.string().min(8).optional()
})
