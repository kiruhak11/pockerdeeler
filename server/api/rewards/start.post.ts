import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { startReward } from '../../services/rewardService'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const parsed = z.object({ requestId: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректная попытка просмотра' })
  return startReward(accountCookie(event), parsed.data.requestId)
})
