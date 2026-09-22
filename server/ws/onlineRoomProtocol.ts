import { z } from 'zod'
import { BETTING_ACTION_TYPES } from '../utils/pokerBetting'

export const ONLINE_ROOM_PROTOCOL_VERSION = 1 as const
export const ONLINE_ROOM_MAX_MESSAGE_BYTES = 16 * 1024

export const onlineRoomActionSchema = z.object({
  type: z.enum(BETTING_ACTION_TYPES),
  amount: z.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  if ((value.type === 'bet' || value.type === 'raise') && value.amount === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bet and raise require amount.' })
  }
  if (value.type !== 'bet' && value.type !== 'raise' && value.amount !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'This action does not accept amount.' })
  }
})

export const onlineRoomClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(ONLINE_ROOM_PROTOCOL_VERSION), type: z.literal('PING') }).strict(),
  z.object({ version: z.literal(ONLINE_ROOM_PROTOCOL_VERSION), type: z.literal('REQUEST_STATE') }).strict(),
  z.object({
    version: z.literal(ONLINE_ROOM_PROTOCOL_VERSION),
    type: z.literal('PLAYER_ACTION'),
    actionId: z.string().min(8).max(128),
    expectedTableStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    action: onlineRoomActionSchema
  }).strict(),
  z.object({
    version: z.literal(ONLINE_ROOM_PROTOCOL_VERSION),
    type: z.literal('START_HAND'),
    expectedTableStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }).strict()
])

export type OnlineRoomClientMessage = z.infer<typeof onlineRoomClientMessageSchema>

export function parseOnlineRoomClientMessage(raw: string): OnlineRoomClientMessage | null {
  if (typeof raw !== 'string' || raw.length > ONLINE_ROOM_MAX_MESSAGE_BYTES) return null
  try {
    const parsed = onlineRoomClientMessageSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
