import { z } from 'zod'

const quickBetStepsSchema = z.array(z.number().int().positive().max(1_000_000)).min(1).max(10)
const chipAmount = z.number().int().positive().max(2_000_000_000)

const buyInSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  minBuyIn: chipAmount.default(5000),
  maxBuyIn: chipAmount.default(7000),
  allowTopUp: z.boolean().default(false)
}).default({ enabled: true, minBuyIn: 5000, maxBuyIn: 7000, allowTopUp: false })

const predictionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  grantMode: z.enum(['original_buy_in', 'fixed']).default('original_buy_in'),
  fixedGrant: chipAmount.optional(),
  minStake: chipAmount.default(100),
  maxStake: chipAmount.default(1000),
  maxStakePercentOfGrant: z.number().int().min(1).max(100).default(20),
  gracePeriodSeconds: z.number().int().min(0).max(60).default(10),
  virtualLiquidityPerMarket: chipAmount.default(1000),
  treasuryInitialBalance: chipAmount.default(100000),
  behaviorImpact: z.number().min(0).max(0.35).default(0.2),
  includeDecisionTime: z.boolean().default(false),
  comebackMinBuyIn: chipAmount.default(5000),
  comebackMaxBuyIn: chipAmount.default(7000),
  maxReentriesPerMember: z.number().int().min(0).max(10).default(1),
  requireDealerApprovalForReentry: z.boolean().default(true)
}).default({
  enabled: true,
  grantMode: 'original_buy_in',
  minStake: 100,
  maxStake: 1000,
  maxStakePercentOfGrant: 20,
  gracePeriodSeconds: 10,
  virtualLiquidityPerMarket: 1000,
  treasuryInitialBalance: 100000,
  behaviorImpact: 0.2,
  includeDecisionTime: false,
  comebackMinBuyIn: 5000,
  comebackMaxBuyIn: 7000,
  maxReentriesPerMember: 1,
  requireDealerApprovalForReentry: true
})

const rosterSettingsSchema = z.object({
  requireDealerApproval: z.boolean().default(true),
  lockRosterAfterGameStart: z.boolean().default(true),
  allowDealerAccountRebinding: z.boolean().default(true)
}).default({ requireDealerApproval: true, lockRosterAfterGameStart: true, allowDealerAccountRebinding: true })

export const createRoomSchema = z.object({
  accessMode: z.enum(['public', 'private']).default('public'),
  playerPolicy: z.enum(['mixed', 'accounts', 'guests']).default('mixed'),
  password: z.string().max(128).optional(),
  name: z.string().min(2).max(80),
  startingStack: z.number().int().positive().max(1_000_000),
  smallBlind: z.number().int().positive().optional(),
  bigBlind: z.number().int().positive().optional(),
  maxPlayers: z.number().int().min(2).max(10),
  quickBetSteps: quickBetStepsSchema.optional(),
  allowLateJoin: z.boolean(),
  requireDealerActionApproval: z.boolean(),
  allowSpectators: z.boolean(),
  buyIn: buyInSettingsSchema.optional(),
  predictions: predictionSettingsSchema.optional(),
  roster: rosterSettingsSchema.optional(),
  authToken: z.string().min(16).optional()
}).superRefine((value, context) => {
  const buyIn = value.buyIn ?? buyInSettingsSchema.parse(undefined)
  const predictions = value.predictions ?? predictionSettingsSchema.parse(undefined)
  if (buyIn.maxBuyIn < buyIn.minBuyIn) context.addIssue({ code: z.ZodIssueCode.custom, path: ['buyIn', 'maxBuyIn'], message: 'Максимальный бай-ин не может быть меньше минимального' })
  if (predictions.maxStake < predictions.minStake) context.addIssue({ code: z.ZodIssueCode.custom, path: ['predictions', 'maxStake'], message: 'Максимальный прогноз не может быть меньше минимального' })
  if (predictions.comebackMaxBuyIn < predictions.comebackMinBuyIn) context.addIssue({ code: z.ZodIssueCode.custom, path: ['predictions', 'comebackMaxBuyIn'], message: 'Максимальная сумма возврата не может быть меньше минимальной' })
  if (predictions.enabled && predictions.treasuryInitialBalance < predictions.virtualLiquidityPerMarket) context.addIssue({ code: z.ZodIssueCode.custom, path: ['predictions', 'treasuryInitialBalance'], message: 'Резерв должен покрывать ликвидность хотя бы одной раздачи' })
})

export const joinRoomSchema = z.object({
  password: z.string().max(128).optional(),
  name: z.string().min(1).max(32),
  role: z.enum(['player', 'spectator']).optional(),
  authToken: z.string().min(16).optional(),
  buyInAmount: chipAmount.optional(),
  clientRequestId: z.string().min(3).max(128).optional()
})

export const playerActionSchema = z.object({
  playerId: z.string().uuid(),
  token: z.string().min(8),
  type: z.enum(['check', 'bet', 'call', 'raise', 'fold', 'all-in']),
  amount: z.number().int().nonnegative().default(0),
  clientRequestId: z.string().min(3).max(128),
  // Optional during rollout for installed older clients; new clients send both.
  handId: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
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
  potWinners: z.record(z.array(z.string().uuid()).min(1).max(10)).optional(),
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
  allowSpectators: z.boolean().optional(),
  buyIn: buyInSettingsSchema.optional(),
  predictions: predictionSettingsSchema.optional(),
  roster: rosterSettingsSchema.optional()
})

export const buyInSchema = z.object({
  accountToken: z.string().min(16),
  memberId: z.string().uuid(),
  amount: chipAmount,
  clientRequestId: z.string().min(3).max(128)
})

export const predictionBetSchema = z.object({
  accountToken: z.string().min(16),
  memberId: z.string().uuid(),
  candidatePlayerId: z.string().uuid(),
  stake: chipAmount,
  clientRequestId: z.string().min(3).max(128),
  expectedMarketRevision: z.number().int().positive()
})

export const predictionVoidSchema = z.object({
  dealerSecret: z.string().min(8),
  reason: z.string().trim().min(3).max(160)
})

export const reentryRequestSchema = z.object({
  accountToken: z.string().min(16),
  memberId: z.string().uuid(),
  amount: chipAmount,
  clientRequestId: z.string().min(3).max(128)
})

export const reentryDecisionSchema = z.object({
  dealerSecret: z.string().min(8),
  decision: z.enum(['approve', 'reject'])
})

export const memberDecisionSchema = z.object({
  dealerSecret: z.string().min(8),
  decision: z.enum(['approve', 'reject']),
  rebindMemberId: z.string().uuid().optional()
})

export const registerSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(128)
})

export const loginSchema = registerSchema

const accountToken = z.string().min(16).or(z.literal('cookie-session'))

export const authTokenSchema = z.object({
  token: accountToken
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
  token: accountToken,
  username: z.string().min(3).max(32)
})

export const changePasswordSchema = z.object({
  token: accountToken,
  currentPassword: z.string().min(6).max(128),
  newPassword: z.string().min(6).max(128)
})

export const sendFriendRequestSchema = z.object({
  token: accountToken,
  username: z.string().min(3).max(32)
})

export const respondFriendRequestSchema = z.object({
  token: accountToken,
  requestId: z.string().uuid(),
  decision: z.enum(['accept', 'reject'])
})

export const inviteFriendToRoomSchema = z.object({
  token: accountToken,
  friendUserId: z.string().uuid()
})

export const respondRoomInviteSchema = z.object({
  token: accountToken,
  inviteId: z.string().uuid(),
  decision: z.enum(['accept', 'decline'])
})

export const roomChatMessageSchema = z.object({
  message: z.string().min(1).max(300),
  participantId: z.string().uuid().optional(),
  token: z.string().min(8).optional(),
  dealerSecret: z.string().min(8).optional()
})
