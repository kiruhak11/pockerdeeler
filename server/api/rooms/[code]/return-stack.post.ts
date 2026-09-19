import { z } from 'zod'
import { returnPlayerStack } from '../../../services/roomService'
import { broadcastRoomState } from '../../../ws/roomHub'
import { accountCookie } from '../../../utils/accountCookie'
import { assertRateLimit } from '../../../utils/rateLimit'
const schema = z.object({ accountToken: z.string().optional(), memberId: z.string().uuid(), amount: z.number().int().positive().max(2_000_000_000), clientRequestId: z.string().min(8).max(128) })
export default defineEventHandler(async event => {
  assertRateLimit(event, 'stack-return', { limit: 60 })
  const code = getRouterParam(event, 'code')?.toUpperCase()
  const input = schema.safeParse(await readBody(event))
  if (!code || !input.success) throw createError({ statusCode: 400, statusMessage: 'Проверьте сумму возврата и участника' })
  const token = accountCookie(event) || input.data.accountToken || getHeader(event, 'authorization')?.replace(/^Bearer /i, '')
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Войдите в аккаунт' })
  const state = await returnPlayerStack({ ...input.data, accountToken: token, roomCode: code })
  broadcastRoomState(code, state)
  return { success: true, state }
})
