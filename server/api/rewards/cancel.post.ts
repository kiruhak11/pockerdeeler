import { z } from 'zod'
import { accountCookie, assertSameOrigin } from '../../utils/accountCookie'
import { cancelReward } from '../../services/rewardService'
export default defineEventHandler(async event => {
  assertSameOrigin(event)
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Некорректная попытка просмотра' })
  return cancelReward(accountCookie(event), parsed.data.id)
})
