import { assertYandexAuthLimit } from '../../../utils/yandexAuthLimit'
import { requireYandexBearer } from '../../../utils/yandexBearer'
import { getYandexRewardedState } from '../../../services/yandexRewardedService'

export default defineEventHandler(async event => {
  await assertYandexAuthLimit(event, 'rewarded-state', 60, 60_000)
  return getYandexRewardedState(requireYandexBearer(event))
})
