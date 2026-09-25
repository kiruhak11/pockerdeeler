import { z } from 'zod'
import { assertSameOrigin } from '../../../utils/accountCookie'
import { assertYandexAuthLimit } from '../../../utils/yandexAuthLimit'
import { requireYandexBearer } from '../../../utils/yandexBearer'
import { startYandexRewardedAttempt } from '../../../services/yandexRewardedService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  await assertYandexAuthLimit(event, 'rewarded-start', 12, 60_000)
  const parsed = z.object({ requestId: z.string().uuid() }).strict().safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор запроса' })
  return startYandexRewardedAttempt(requireYandexBearer(event), parsed.data.requestId)
})
