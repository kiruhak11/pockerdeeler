import { accountCookie } from '../../utils/accountCookie'
import { getRewardState } from '../../services/rewardService'
export default defineEventHandler(event => getRewardState(accountCookie(event)))
