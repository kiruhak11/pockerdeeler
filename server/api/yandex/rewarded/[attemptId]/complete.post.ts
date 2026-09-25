import { z } from 'zod'
import { getRouterParam } from 'h3'
import { assertSameOrigin } from '../../../../utils/accountCookie'
import { assertYandexAuthLimit } from '../../../../utils/yandexAuthLimit'
import { requireYandexBearer } from '../../../../utils/yandexBearer'
import { completeYandexRewardedAttempt } from '../../../../services/yandexRewardedService'

export default defineEventHandler(async event => {
  assertSameOrigin(event)
  await assertYandexAuthLimit(event, 'rewarded-complete', 30, 60_000)
  const attemptId = z.string().uuid().parse(getRouterParam(event, 'attemptId'))
  return completeYandexRewardedAttempt(requireYandexBearer(event), attemptId)
})
